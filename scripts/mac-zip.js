// mac 交叉打包用的最小 ZIP 读写工具
// 为什么不用现成库：mac 的 .app 里有符号链接（Electron Framework 的 Versions/Current 等），
// 在 Windows 上解压再压缩会丢掉符号链接和可执行权限位，生成的包在 mac 上直接跑不起来。
// 这里直接按中央目录逐条搬运原始压缩数据，只改条目名、只追加新文件，符号链接条目和权限位原样保留。
const fs = require('fs');
const zlib = require('zlib');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

// CRC32 查表：zip 条目头里要写校验值，不能省略
const CRC_TABLE = (function makeTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * 计算一段数据的 CRC32
 * @param {Buffer} buf 待计算数据
 * @returns {number} 无符号 32 位校验值
 */
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/**
 * 把 JS 的 Date 转成 zip 的 DOS 时间/日期两个 16 位字段
 * @param {Date} date 时间
 * @returns {{time:number,date:number}} DOS 格式的时间与日期
 */
function toDosTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const time = ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5) | (Math.floor(date.getSeconds() / 2) & 0x1F);
  const day = (((year - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0x0F) << 5) | (date.getDate() & 0x1F);
  return { time, date: day };
}

/** ZIP 读取器：只按需读，不把整包读进内存 */
class ZipReader {
  /**
   * @param {string} filePath zip 文件路径
   */
  constructor(filePath) {
    this.filePath = filePath;
    this.fd = fs.openSync(filePath, 'r');
    this.size = fs.fstatSync(this.fd).size;
    this.entries = this._readCentralDirectory();
  }

  // 从文件指定位置读一段
  _readAt(offset, length) {
    const buf = Buffer.alloc(length);
    fs.readSync(this.fd, buf, 0, length, offset);
    return buf;
  }

  // 解析中央目录，返回全部条目（含符号链接条目的原始属性）
  _readCentralDirectory() {
    const tailLen = Math.min(this.size, 22 + 0xFFFF);
    const tail = this._readAt(this.size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('不是有效的 zip：找不到中央目录结尾');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xFFFF || cdOffset === 0xFFFFFFFF) {
      throw new Error('暂不支持 zip64 源包：' + this.filePath);
    }
    const cd = this._readAt(cdOffset, cdSize);
    const list = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('中央目录条目损坏（第 ' + (i + 1) + ' 条）');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const modTime = cd.readUInt16LE(p + 12);
      const modDate = cd.readUInt16LE(p + 14);
      const crc = cd.readUInt32LE(p + 16);
      const compSize = cd.readUInt32LE(p + 20);
      const uncompSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const intAttr = cd.readUInt16LE(p + 36);
      const extAttr = cd.readUInt32LE(p + 38);
      const localOffset = cd.readUInt32LE(p + 42);
      const name = cd.slice(p + 46, p + 46 + nameLen).toString('utf8');
      const extra = cd.slice(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      list.push({
        name, flags, method, modTime, modDate, crc, compSize, uncompSize,
        intAttr, extAttr, localOffset, extra: Buffer.from(extra)
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return list;
  }

  /**
   * 取一个条目的完整原始字节区间（本地头 + 名字 + 扩展 + 压缩数据 + 可能的数据描述符）
   * @param {object} entry 条目
   * @returns {{header:Buffer, name:Buffer, extra:Buffer, data:Buffer, tail:Buffer}}
   */
  readRaw(entry) {
    const local = this._readAt(entry.localOffset, 30);
    if (local.readUInt32LE(0) !== SIG_LOCAL) throw new Error('本地头损坏：' + entry.name);
    const nameLen = local.readUInt16LE(26);
    const extraLen = local.readUInt16LE(28);
    const header = local;
    const name = this._readAt(entry.localOffset + 30, nameLen);
    const extra = this._readAt(entry.localOffset + 30 + nameLen, extraLen);
    const dataStart = entry.localOffset + 30 + nameLen + extraLen;
    const data = this._readAt(dataStart, entry.compSize);
    // flags bit3 表示大小写在数据后面的描述符里，搬运时要把描述符一起带上
    let tail = Buffer.alloc(0);
    if (entry.flags & 0x8) {
      const rest = this._readAt(dataStart + entry.compSize, Math.min(16, this.size - (dataStart + entry.compSize)));
      tail = rest;
    }
    return { header, name, extra, data, tail };
  }

  /**
   * 读出一个条目解压后的内容（只对需要改内容的条目用，例如 Info.plist）
   * @param {object} entry 条目
   * @returns {Buffer} 解压后的数据
   */
  readContent(entry) {
    if (entry.name.endsWith('/')) return Buffer.alloc(0);
    const raw = this.readRaw(entry);
    if (entry.method === 0) return raw.data;
    if (entry.method === 8) return zlib.inflateRawSync(raw.data);
    throw new Error('不支持的压缩方式 ' + entry.method + '：' + entry.name);
  }

  close() {
    try { fs.closeSync(this.fd); } catch { /* 已经关掉 */ }
  }
}

/** ZIP 写入器：先写本地头和数据，最后统一写中央目录 */
class ZipWriter {
  /**
   * @param {string} filePath 输出 zip 路径
   */
  constructor(filePath) {
    this.filePath = filePath;
    this.fd = fs.openSync(filePath, 'w');
    this.offset = 0;
    this.central = [];
    this.count = 0;
    this.buf = Buffer.alloc(0);
  }

  // 攒一小段输出，减少系统调用
  _write(buf) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, buf]) : buf;
    if (this.buf.length >= 8 * 1024 * 1024) this._flush();
  }

  _flush() {
    if (!this.buf.length) return;
    fs.writeSync(this.fd, this.buf, 0, this.buf.length, this.offset);
    this.offset += this.buf.length;
    this.buf = Buffer.alloc(0);
  }

  /**
   * 原样搬运一个已有条目，只替换条目名
   * @param {object} entry 原条目
   * @param {Buffer} raw readRaw 的结果
   * @param {string} newName 新条目名
   */
  copyEntry(entry, raw, newName) {
    const start = this._entryStart();
    const nameBuf = Buffer.from(newName, 'utf8');
    const header = Buffer.from(raw.header);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(raw.extra.length, 28);
    this._write(header);
    this._write(nameBuf);
    if (raw.extra.length) this._write(raw.extra);
    if (raw.data.length) this._write(raw.data);
    if (raw.tail.length) this._write(raw.tail);
    this.central.push({
      name: nameBuf, flags: entry.flags, method: entry.method, modTime: entry.modTime,
      modDate: entry.modDate, crc: entry.crc, compSize: entry.compSize,
      uncompSize: entry.uncompSize, intAttr: entry.intAttr, extAttr: entry.extAttr,
      localOffset: start
    });
    this.count += 1;
  }

  /**
   * 追加（或替换）一个普通文件
   * @param {string} name 条目名（使用 / 分隔）
   * @param {Buffer} content 文件内容
   * @param {{mode?:number, date?:Date}} options mode 为 Unix 权限位（目录用 0o40755），date 为修改时间
   */
  addFile(name, content, options) {
    const opts = options || {};
    const isDir = name.endsWith('/');
    const mode = opts.mode || (isDir ? 0o40755 : 0o100644);
    const date = opts.date || new Date();
    const dos = toDosTime(date);
    const nameBuf = Buffer.from(name, 'utf8');
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const deflated = isDir || body.length === 0 ? body : zlib.deflateRawSync(body, { level: 6 });
    const useDeflate = !isDir && body.length > 0;
    const crc = isDir || body.length === 0 ? 0 : crc32(body);
    const start = this._entryStart();
    const header = Buffer.alloc(30);
    header.writeUInt32LE(SIG_LOCAL, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(useDeflate ? 8 : 0, 8);
    header.writeUInt16LE(dos.time, 10);
    header.writeUInt16LE(dos.date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(useDeflate ? deflated.length : body.length, 18);
    header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    this._write(header);
    this._write(nameBuf);
    if (useDeflate) this._write(deflated);
    else if (body.length) this._write(body);
    this.central.push({
      name: nameBuf, flags: 0x0800, method: useDeflate ? 8 : 0, modTime: dos.time,
      modDate: dos.date, crc, compSize: useDeflate ? deflated.length : body.length,
      uncompSize: body.length, intAttr: 0, extAttr: ((mode & 0xFFFF) << 16) >>> 0,
      localOffset: start
    });
    this.count += 1;
  }

  // 记录当前条目在包里的起始偏移
  _entryStart() {
    return this.offset + this.buf.length;
  }

  // 写中央目录并收尾
  finish() {
    const cdStart = this.offset + this.buf.length;
    const parts = [];
    for (const e of this.central) {
      const buf = Buffer.alloc(46);
      buf.writeUInt32LE(SIG_CENTRAL, 0);
      buf.writeUInt16LE((3 << 8) | 20, 4);
      buf.writeUInt16LE(20, 6);
      buf.writeUInt16LE(e.flags, 8);
      buf.writeUInt16LE(e.method, 10);
      buf.writeUInt16LE(e.modTime, 12);
      buf.writeUInt16LE(e.modDate, 14);
      buf.writeUInt32LE(e.crc, 16);
      buf.writeUInt32LE(e.compSize, 20);
      buf.writeUInt32LE(e.uncompSize, 24);
      buf.writeUInt16LE(e.name.length, 28);
      buf.writeUInt16LE(0, 30);
      buf.writeUInt16LE(0, 32);
      buf.writeUInt16LE(0, 34);
      buf.writeUInt16LE(e.intAttr, 36);
      buf.writeUInt32LE(e.extAttr, 38);
      buf.writeUInt32LE(e.localOffset, 42);
      parts.push(buf, e.name);
    }
    const cd = Buffer.concat(parts);
    this._write(cd);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(this.count, 8);
    eocd.writeUInt16LE(this.count, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    this._write(eocd);
    this._flush();
    fs.closeSync(this.fd);
  }
}

module.exports = { ZipReader, ZipWriter, crc32 };
