// DOCX 参考导图验收：用真实 Word 样式及编号定义生成最小文档，核对实际导入与持久化。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const mammoth = require('mammoth');
const { createReferenceTree } = require('../electron/lib/reference-tree');

/**
 * 创建含真实标题样式、混合三级编号及普通正文的 DOCX 附件。
 * @param {string} directory 测试临时目录
 * @param {boolean} [includeImage] 是否额外嵌入一张真实 PNG，用于核对原有媒体识别通道
 * @returns {Promise<string>} 已写入的 DOCX 绝对路径，不写入用户资料或项目资源
 */
async function createDocxFixture(directory, includeImage) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="numbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>');
  zip.file('word/styles.xml', '<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="标题 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="标题 2"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="标题 3"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr></w:style></w:styles>');
  zip.file('word/numbering.xml', '<?xml version="1.0" encoding="UTF-8"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="multilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl><w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%3."/></w:lvl></w:abstractNum><w:num w:numId="42"><w:abstractNumId w:val="0"/></w:num></w:numbering>');
  const paragraphs = [
    paragraph('角色方案', '<w:pStyle w:val="Heading1"/>'),
    paragraph('界面布局', '<w:pStyle w:val="Heading2"/>'),
    paragraph('顶部导航', numbering(0)),
    paragraph('角色入口', numbering(1)),
    paragraph('详情按钮', numbering(2)),
    paragraph('活动入口', numbering(1)),
    paragraph('底部操作', numbering(0)),
    paragraph('普通正文 # 不冒充标题'),
    paragraph('# 这不是Word标题'),
    paragraph('保留反斜线：C:\\_assets\\#角色'),
    paragraph('配色规则', '<w:pStyle w:val="Heading2"/>'),
    paragraph('按钮状态', '<w:pStyle w:val="Heading3"/>'),
    paragraph('蓝色与金色 & 强调'),
    paragraph('- 普通条目没有列表样式'),
    paragraph('* 普通星号段落'),
    paragraph('保留星号：*角色*'),
    paragraph('最终说明', '<w:pStyle w:val="Heading1"/>'),
    paragraph('1. 这是普通正文，不是列表')
  ];
  if (includeImage) {
    const relations = await zip.file('word/_rels/document.xml.rels').async('string');
    const relationshipEnd = relations.indexOf('</Relationships>');
    zip.file('word/_rels/document.xml.rels', relations.substring(0, relationshipEnd) + '<Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>' + relations.substring(relationshipEnd));
    const types = await zip.file('[Content_Types].xml').async('string');
    const typesEnd = types.indexOf('</Types>');
    zip.file('[Content_Types].xml', types.substring(0, typesEnd) + '<Default Extension="png" ContentType="image/png"/>' + types.substring(typesEnd));
    // 用合法 PNG 文本块让样本超过既有媒体解析器的 800 字节小图过滤线，不修改生产过滤规则。
    const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const metadata = Buffer.from('Comment\0' + 'reference sample '.repeat(100), 'utf8');
    const chunk = Buffer.alloc(metadata.length + 12);
    chunk.writeUInt32BE(metadata.length, 0);
    chunk.write('tEXt', 4, 'ascii');
    metadata.copy(chunk, 8);
    chunk.writeUInt32BE(require('zlib').crc32(chunk.subarray(4, chunk.length - 4)), chunk.length - 4);
    zip.file('word/media/image1.png', Buffer.concat([pixel.subarray(0, pixel.length - 12), chunk, pixel.subarray(pixel.length - 12)]));
    paragraphs.push('<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rIdImage"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>');
  }
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + paragraphs.join('') + '<w:sectPr/></w:body></w:document>');
  const name = includeImage ? 'reference-with-image.docx' : '真实标题与混合列表.docx';
  const target = path.join(directory, name);
  fs.writeFileSync(target, await zip.generateAsync({type:'nodebuffer'}));
  return target;
}

/** 把测试正文与段落属性写成有效 XML；返回完整段落，不凭可见文字添加样式。 */
function paragraph(text, properties) {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return '<w:p>' + (properties ? '<w:pPr>' + properties + '</w:pPr>' : '') + '<w:r><w:t>' + escaped + '</w:t></w:r></w:p>';
}

/** 返回指定真实编号层级的段落属性；level 是 Word 的零起始 ilvl。 */
function numbering(level) {
  return '<w:numPr><w:ilvl w:val="' + level + '"/><w:numId w:val="42"/></w:numPr>';
}

/** 用生产服务导入真实 DOCX，核对结构、正文与重新读取行为；失败令进程退出非零。 */
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spcode-docx-reference-'));
  const file = await createDocxFixture(directory);
  const markdown = await mammoth.convertToMarkdown({path:file});
  const html = await mammoth.convertToHtml({path:file});
  console.log(JSON.stringify({stage:'真实DOCX结构转换',markdown:markdown.value,html:html.value,messages:html.messages},null,2));
  const sessionDir = function sessionDir() { return path.join(directory, 'sessions'); };
  const service = createReferenceTree({sessionDir});
  const payload = {tabId:'docx-structure',files:[{path:file,name:path.basename(file)}]};
  const map = await service.importFiles(payload);
  assertEdge(map, '角色方案', '界面布局');
  assertEdge(map, '界面布局', '顶部导航');
  assertEdge(map, '顶部导航', '角色入口');
  assertEdge(map, '角色入口', '详情按钮');
  assertEdge(map, '顶部导航', '活动入口');
  assertEdge(map, '界面布局', '底部操作');
  assertEdge(map, '界面布局', '# 这不是Word标题');
  assertEdge(map, '界面布局', '保留反斜线：C:\\_assets\\#角色');
  assertEdge(map, '角色方案', '配色规则');
  assertEdge(map, '配色规则', '按钮状态');
  assertEdge(map, '按钮状态', '蓝色与金色 & 强调');
  assertEdge(map, '按钮状态', '- 普通条目没有列表样式');
  assertEdge(map, '按钮状态', '* 普通星号段落');
  assertEdge(map, '按钮状态', '保留星号：*角色*');
  assertEdge(map, path.basename(file), '最终说明');
  assertEdge(map, '最终说明', '1. 这是普通正文，不是列表');
  assert.deepEqual(createReferenceTree({sessionDir}).read({tabId:payload.tabId}), map);
  assert.deepEqual(await service.importFiles(payload), map, '重新导入相同文件必须保持层级且不重复节点');
  const imageFile = await createDocxFixture(directory, true);
  let imageCalls = 0;
  const imageService = createReferenceTree({sessionDir,recognizeImage:recognizeEmbeddedImage});
  const imageMap = await imageService.importFiles({tabId:'docx-image-structure',files:[{path:imageFile,name:path.basename(imageFile)}]});
  assert.equal(imageCalls, 1, '真实媒体解析器提取的内嵌图仅交给原视觉接口一次');
  assertEdge(imageMap, '角色方案', '界面布局');
  assertEdge(imageMap, '内嵌画面', '实际取出的像素');
  assertEdge(imageMap, '内嵌画面', '识别原文：\\\\*保留反斜线');
  for (const node of imageMap.nodes) assert(!node.requirement.includes('data:image'), '内嵌图片不得重复编码为参考正文或巨型文本节点');
  console.log(JSON.stringify({ok:true,checks:['Word中文Heading1至3样式','三级有序及无序混合列表','同级列表回退','标题与列表父子边','普通井号星号短横线及编号正文不猜层级','原始反斜线星号及XML实体','会话存档恢复及去重','真实内嵌图片提取及原视觉接口边界'],file},null,2));

  /** 核对真实 DOCX 提取出的 PNG，按现有视觉接口返回层级文本；此测试不声称配置模型已识别图片。 */
  async function recognizeEmbeddedImage(dataUrl, name) {
    assert.match(dataUrl, /^data:image\/png;base64,/);
    assert(name.includes('image1.png'));
    imageCalls++;
    return '# 内嵌画面\n- 实际取出的像素\n- 识别原文：\\\\*保留反斜线';
  }
}

/** 核对唯一文本节点间存在真实父子边；缺失时给出具体关系与现存节点。 */
function assertEdge(map, parentTitle, childTitle) {
  const parent = map.nodes.find(function parentNode(node) { return node.title === parentTitle; });
  const child = map.nodes.find(function childNode(node) { return node.title === childTitle; });
  assert(parent && child, '必须保留节点：' + parentTitle + ' → ' + childTitle);
  assert(map.edges.some(function matchingEdge(edge) { return edge.from === parent.id && edge.to === child.id; }), '必须保留结构边：' + parentTitle + ' → ' + childTitle);
}

/** 记录实际失败并返回非零状态，不将未执行或失败的导入当成通过。 */
function failed(error) { console.error(error.stack || String(error)); process.exitCode = 1; }

module.exports = { createDocxFixture, assertEdge };
if (require.main === module) main().catch(failed);
