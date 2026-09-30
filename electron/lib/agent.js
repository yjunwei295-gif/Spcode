const fs = require('fs');
const path = require('path');
const { safeJoin, resolveAllowed, resolveRead, resolveWrite, extraRoots, listTree, readTextFile, readLineRange, isInside, isForeignAiSkill, SKIP } = require('./workspace');
const snapshot = require('./snapshot');
const skillsLib = require('./skills');
const { parseAttachment, isDocumentExt, isImageExt } = require('./media');
const localLlm = require('./local-llm');
const zbaingAi = require('./zbaingAi');
const store = require('./store');
const diag = require('./diag');
const assembly = require('./assembly');
const mmproj = require('./mmproj');
const visionEngine = require('./vision-engine');
const replyLang = require('./reply-lang');
const webSearch = require('./web-search');
const generate = require('./generate');
const memory = require('./memory');
const memoryGlobal = require('./memory-global');
const compact = require('./context-compact');
const retrieve = require('./memory-retrieve');
const codeIndex = require('./code-index');
const brainPressure = require('./brain-pressure');
const codeEmbed = require('./code-embed');
const typecheck = require('./typecheck');
const apiProtocol = require('./api-protocol');
const sandbox = require('./sandbox');
const toolXml = require('./tool-xml');
const houseStyle = require('./house-style');
// 看图端点请求统一走 httpFetch（Electron net.fetch，与聊天主链路同用系统代理），避免裸 fetch 在代理环境下 fetch failed
const { httpFetch } = require('./http-fetch');

const DEFAULT_MAX_ROUNDS = 16;
const SAFETY_MAX_ROUNDS = 128;

// [铆钉优化] 桌面工具只在「AGI」打开时给模型，关着时模型看不到也不会乱报"AGI 没开"。其他 AI 请勿改回始终暴露。
const DESKTOP_TOOLS = new Set([
  'screen_read', 'screen_look', 'clipboard_look', 'window_list', 'window_focus', 'ui_act', 'agi_note',
  'mouse_move', 'mouse_click', 'mouse_drag', 'mouse_scroll', 'keyboard_type', 'keyboard_key'
]);

// [铆钉优化] 危险桌面操作（删除、发送、付款、永久删除等）先问用户，由 agentLoop 接住后弹选项。其他 AI 请勿删除或改成默认放行
const RISK_ALLOW = '允许这一步';
const RISK_ALLOW_TURN = '这一轮都允许';
const RISK_DENY = '不允许';

function guardDesktop(name, args, run) {
  const desktopHand = require('./desktop-hand');
  const reason = desktopHand.assessRisk(name, args);
  if (!reason) return run();
  const err = new Error('DESKTOP_CONFIRM');
  err.code = 'desktop_confirm';
  err.ask = {
    question: `AGI ${reason}要继续吗？`,
    options: [RISK_ALLOW, RISK_ALLOW_TURN, RISK_DENY],
    allowFreeText: false
  };
  err.proceed = run;
  throw err;
}

function desktopOn() {
  try { return require('./desktop-hand').isAlive(); } catch { return false; }
}

// AGI 开着时，打开软件和网页走键鼠。cmd 的 start、PowerShell 的 Start-Process、直接跑 chrome.exe 会把沙盒拖死。
// npm start 不是启动外部程序，不拦。
function shellLaunchesApp(command) {
  const cmd = String(command || '');
  if (/chrome\.exe/i.test(cmd)) return true;
  if (/\bStart-Process\b/i.test(cmd)) return true;
  if (/(^|[|&;`]|\/[ck]\s+)\s*start\b/i.test(cmd)) return true;
  if (/\bstart\s+""/i.test(cmd)) return true;
  return false;
}

function toolsSpec() {
  const all = allToolsSpec();
  return desktopOn() ? all : all.filter((t) => !DESKTOP_TOOLS.has(t.function?.name));
}

function allToolsSpec() {
  return [
    {
      type: 'function',
      function: {
        name: 'list_dir',
        description: '列出目录。不传 path 时列出工作目录和已添加的附加目录；path 可以是工作区内相对路径，也可以是绝对路径。其他 AI 的技能和规则目录不会列出。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '可选。要列出的目录，支持绝对路径' },
            query: { type: 'string', description: '可选，按路径或文件名过滤' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: '读取文本或解析 Word/Excel/PPT/PDF。path 可以是工作区内相对路径，也可以是绝对路径。禁止读取其他 AI 的技能和规则（.cursor、AGENTS.md、CLAUDE.md，以及本程序技能目录以外的 SKILL.md）。消息里已有【全文】的直接用全文。作用和关键值看得懂又够用时，改那一个方法再用 startLine/endLine。归纳看不懂、里面没有要改的文案数字字段、只有方法名、或消息里没有正文时，整文件读原本代码。不准猜。文件太大（如 .unity 场景、prefab）不会整读，只返回行数和开头；这时先用 search_text（path 填该文件）拿行号，再用 startLine/endLine 读片段，一次最多 600 行。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对路径或绝对路径' },
            startLine: { type: 'integer', description: '可选。起始行（1 起），与 endLine 配合只读片段' },
            endLine: { type: 'integer', description: '可选。结束行（含）' }
          },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: '写入或覆盖文件（UTF-8）。工作目录、附加目录，以及已经存在的绝对路径文件都可以写回。已经读到的文件禁止说找不到。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' }
          },
          required: ['path', 'content']
        }
      }
    },
    // [铆钉优化] 局部替换：改已有文件首选它，不用整份重写，也不用 run_command 跑脚本替换；保留原文件 BOM 和换行符。其他 AI 请勿删除
    {
      type: 'function',
      function: {
        name: 'edit_file',
        description: '改已有文件的首选工具：把文件里的 old_string 原样替换成 new_string，其余内容不动，保留原来的编码 BOM 和换行符。old_string 必须从 read_file 结果里原样复制（不带行号前缀），包含足够上下文使它在文件里唯一；要替换所有出现处时设 replace_all=true。同一文件多处修改可连续调用多次。新建文件或几乎整份重写时才用 write_file。禁止用 run_command 跑 python/node/powershell 脚本改文件。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对路径或已读到的绝对路径' },
            old_string: { type: 'string', description: '要被替换的原文，必须与文件内容逐字一致' },
            new_string: { type: 'string', description: '替换后的新内容' },
            replace_all: { type: 'boolean', description: '可选。true 时替换所有出现处' }
          },
          required: ['path', 'old_string', 'new_string']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'create_dir',
        description: '在工作目录、附加目录或技能/规则目录内新建文件夹。可一次创建多层（如 a/b/c）。已存在则直接成功。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '要创建的文件夹，相对路径或允许范围内的绝对路径' }
          },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'delete_file',
        description: '删除工作目录内的文件。会先自动快照。',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'search_text',
        description: '按关键字精确搜索源码文本（符号、字符串、报错原文）。不传 path 时搜工作目录和已添加的附加目录。其他 AI 的技能和规则文件不参与搜索。找某功能在哪实现请先用 map_lookup 查项目地图。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            glob: { type: 'string', description: '可选扩展名，如 .js' },
            path: { type: 'string', description: '可选。要搜索的目录或单个文件，支持绝对路径。大文件（如 .unity 场景）填文件路径，会返回匹配的行号' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'semantic_search',
        description: '按语义在本地向量索引里找相关代码片段。不知道符号名、只知道意图时用它。精确符号用 search_text，已知方法名用 goto_definition。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '自然语言，如“登录后如何保存会话”' },
            path: { type: 'string', description: '可选。只在该目录内检索，支持绝对路径' },
            limit: { type: 'integer', description: '返回条数，默认 8，最大 16' }
          },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'goto_definition',
        description: '按符号名跳到定义。返回项目地图里该符号的文件、行号和附近源码。同名多处会都列出来。',
        parameters: {
          type: 'object',
          properties: {
            symbol: { type: 'string', description: '要跳转的符号名，如函数名、类名' }
          },
          required: ['symbol']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'map_lookup',
        description: '查项目地图：按关键字返回命中模块的依赖、方法名、作用与关键值。这是第一批，不是全部。作用和关键值看得懂又够用才能当依据。看不懂归纳、里面没有要改的文案数字字段、或只有方法名时，用 read_file 读原本代码，不准猜。这批对不上就换关键字或传 module 继续查。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '关键字（方法名、模块名、功能词，空格分隔多个）' },
            module: { type: 'string', description: '可选。模块路径（如 electron/lib/agent.js），传了则返回该模块全部方法与依赖' },
            path: { type: 'string', description: '可选。只在该目录内检索' },
            limit: { type: 'integer', description: '返回模块条数，默认 10，最大 30' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'memory_list',
        description: '列出当前项目的防回归记忆（已确认约定/勿破坏项）',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'memory_add',
        description: '写入一条项目约定记忆，供以后改相关功能时遵守',
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: '一句话：原因+结论' },
            paths: { type: 'array', items: { type: 'string' }, description: '相关相对路径' },
            tags: { type: 'array', items: { type: 'string' } },
            pinned: { type: 'boolean', description: '是否每轮强制注入，默认 true' }
          },
          required: ['summary']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'memory_forget',
        description: '删除一条项目长期记忆',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'working_memory_update',
        description: '更新本会话工作记忆（目标、未决问题、焦点文件、临时要点）',
        parameters: {
          type: 'object',
          properties: {
            goal: { type: 'string' },
            openQuestions: { type: 'array', items: { type: 'string' } },
            focusPaths: { type: 'array', items: { type: 'string' } },
            scratch: { type: 'array', items: { type: 'string' } },
            addScratch: { type: 'string' },
            addQuestion: { type: 'string' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'ask_user',
        description: '需求含糊、会破坏已确认约定、或有多种实现时，必须先向用户提问并等待回答，再改文件',
        parameters: {
          type: 'object',
          properties: {
            question: { type: 'string', description: '要问用户的问题' },
            options: { type: 'array', items: { type: 'string' }, description: '可选选项' },
            allowFreeText: { type: 'boolean', description: '是否允许自由输入，默认 true' }
          },
          required: ['question']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'generate_media',
        description: '用「模型组合」里挂的生成模型生成图片 / 视频 / 3D / 文档，结果存到工作目录 generated/ 下并返回路径。用户要生图时直接调用，不需要用户说「开始」，也不要派给代码模块去跑命令。prompt 写你按对话整理好的完整描述（画面主体、风格、构图、颜色等），不要只写「按上面的提示词」。要几张就调用几次。',
        parameters: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['image', 'video', '3d', 'doc'], description: '生成类型，生图填 image' },
            prompt: { type: 'string', description: '完整的生成描述' }
          },
          required: ['kind', 'prompt']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'run_command',
        description: process.platform === 'win32'
          ? '在项目命令沙盒中执行命令（cwd 限制在工作区内，拦截高危命令，有超时）。Windows 下由 cmd.exe 执行：不支持 bash 语法（<<EOF、find -type、单引号字符串），PowerShell 语句要写成 powershell -NoProfile -Command "..."。只用于跑测试、构建、git 状态；改文件一律用 edit_file / write_file，禁止用 python/node/powershell 脚本改文件，也不要用它搜代码（用 search_text）或列目录（用 list_dir）。AGI 开着时，禁止用本工具执行 start、Start-Process 或启动 chrome.exe 来打开软件和网页，改用键鼠。'
          : '在项目命令沙盒中执行 shell 命令（cwd 限制在工作区内，拦截高危命令，有超时）。只用于跑测试、构建、git 状态；改文件一律用 edit_file / write_file，禁止用脚本改文件，搜代码用 search_text。',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: '要执行的命令，如 npm test 或 git status' },
            cwd: { type: 'string', description: '相对工作区的子目录，默认 .' }
          },
          required: ['command']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'screen_read',
        description: '重新识别屏幕文字（本地 OCR，快、不花钱），返回前台窗口、窗口列表和每行文字的中心坐标。等待界面加载时用 wait_ms 先等一会再读。',
        parameters: {
          type: 'object',
          properties: {
            wait_ms: { type: 'integer', description: '读之前等待的毫秒数，最多 10000，默认 0' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'screen_look',
        description: '让看图模型细看当前屏幕（图标、颜色、布局这类 OCR 读不出的东西）。比 screen_read 慢、要花钱，只在文字不够判断时用。',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'ui_act',
        description: '按【屏幕文字】里的控件编号 [c编号] 直接操作控件（Windows UI 自动化），比按坐标点击更准，控件被挡住也能按。有控件编号时优先用它。结果带【操作后】画面变化。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '控件编号，如 c12' },
            action: { type: 'string', description: 'click（默认）、double_click、right_click、toggle、select、expand、collapse、focus、set_text' },
            text: { type: 'string', description: 'set_text 时要填入的内容（会替换原内容）' }
          },
          required: ['id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'agi_note',
        description: '记下一条这个软件的操作经验，下次看到同一个软件会自动带上。任务做成后、或发现不明显的路径和坑时调用。一句话写清：功能在哪、哪条路走得通、哪里要注意。不要记密码、聊天内容等隐私。',
        parameters: {
          type: 'object',
          properties: {
            app: { type: 'string', description: '程序名，如 notepad、chrome、weixin；不填就用当前目标窗口的程序' },
            note: { type: 'string', description: '经验，一句话' }
          },
          required: ['note']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'window_list',
        description: '列出桌面上可切换的窗口（标题和程序名），★ 是当前前台窗口。',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'window_focus',
        description: '把某个窗口切到前台。title 可以是窗口标题的一部分或程序名（如 notepad、chrome）。打字、按键前先确认焦点在目标窗口。',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '窗口标题片段或程序名' }
          },
          required: ['title']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'clipboard_look',
        description: '从剪贴板导入图片，交给看图模型理解并保存。剪贴板里没有图片时会说明。',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'mouse_move',
        description: '把虚拟光标移到画面坐标（只是给用户指一下位置），不移动系统鼠标。x,y 用【屏幕文字】里的坐标。',
        parameters: {
          type: 'object',
          properties: {
            x: { type: 'number', description: '图内横坐标' },
            y: { type: 'number', description: '图内纵坐标' }
          },
          required: ['x', 'y']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'mouse_click',
        description: '在画面坐标处点击，x,y 直接用【屏幕文字】里文字的 @(x,y) 中心点。会短暂借用系统鼠标并放回原处。返回结果里带【操作后】画面变化，据此判断有没有点中。button 为 left、right 或 middle；times 为 2 表示双击。画线、画圆用 mouse_drag。',
        parameters: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            button: { type: 'string', description: 'left、right 或 middle，默认 left' },
            times: { type: 'integer', description: '1 单击，2 双击' }
          },
          required: ['x', 'y']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'mouse_drag',
        description: '按住鼠标沿点拖动再松开，用来画线、画圆。points 至少两个图内坐标，格式 [{x,y},...]。画圆时自己算一圈采样点，从起点拖回起点。会短暂使用系统鼠标并立刻放回原处。',
        parameters: {
          type: 'object',
          properties: {
            points: { type: 'array', description: '图内坐标，按拖动顺序', items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } } },
            button: { type: 'string', description: 'left、right 或 middle，默认 left' }
          },
          required: ['points']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'mouse_scroll',
        description: '在画面坐标处滚动。delta 正数向上，负数向下，约 -120 为一格。',
        parameters: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            delta: { type: 'number', description: '滚轮量，负数向下' }
          },
          required: ['x', 'y']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'keyboard_type',
        description: '向前台窗口的输入焦点打字（逐字 Unicode 输入，中文可直接打，不经过输入法；超过 400 字改用剪贴板粘贴）。换行会按回车。焦点在 SimpleCode 自己身上时会拒绝，先 window_focus 或点一下目标输入框。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '要输入的文字' }
          },
          required: ['text']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'keyboard_key',
        description: '按下按键或组合键，例如 enter、tab、esc、f5、ctrl+s、ctrl+shift+t、alt+f4、win+r、ctrl+/。',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string', description: '键名，组合用加号连接' }
          },
          required: ['key']
        }
      }
    }
  ];
}

const HAND_OFF_TOOLS = new Set(['write_file', 'edit_file', 'create_dir', 'delete_file', 'run_command']);

function callWorkerTool(roles) {
  const hasPlan = roles.includes('planning');
  const hasCode = roles.includes('code');
  let description = '把任务交给部下。';
  let roleDesc = '部下分工';
  let taskDesc = '交给部下的内容';
  if (hasPlan && hasCode) {
    description = '交给部下。planning：你已经理解需求之后，把目标、范围、约束、验收交给规划模块出步骤。code：把改文件交给实现模型。多个文件互不依赖时，同一轮可发多条 code，每条只改自己的文件，程序会同时做。';
    roleDesc = 'planning 或 code';
    taskDesc = 'planning 写你理解后的目标、范围、约束、验收。code 写路径、方法与行号、现状、目标、禁止改动范围。互不依赖的文件拆成多条 code';
  } else if (hasPlan) {
    description = '你已经理解需求之后，把目标、范围、约束、验收交给规划模块出步骤。';
    roleDesc = '规划用 planning';
    taskDesc = '你理解后的目标、范围、约束、验收。不要把用户原文原样转交';
  } else if (hasCode) {
    description = '把改文件、删文件、建目录、执行命令交给实现模型。多个文件互不依赖时，同一轮可发多条，每条只改自己的文件，程序会同时做。';
    roleDesc = '实现分工，改代码用 code';
    taskDesc = '完整派单：路径、方法与行号、现状、目标、禁止改动范围。互不依赖的文件拆成多条';
  }
  return {
    type: 'function',
    function: {
      name: 'call_worker',
      description,
      parameters: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: roles, description: roleDesc },
          task: { type: 'string', description: taskDesc }
        },
        required: ['role', 'task']
      }
    }
  };
}

const WORKER_TOOL_NAMES = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'create_dir',
  'delete_file',
  'search_text',
  'goto_definition',
  'list_dir',
  'run_command'
]);

// brain：有实现模型时不给写文件工具，改由 call_worker 转交。只有规划模块时仍可自己改文件。worker：只留改代码要用的工具
// AGI 开着时不派单：写文件和命令仍等「开始」，开了之后由大脑自己做，不挂 call_worker
function toolsFor(kind, workerRoles, allowDispatch) {
  const all = toolsSpec();
  if (kind === 'worker') return all.filter((t) => WORKER_TOOL_NAMES.has(t.function?.name));
  if (desktopOn() && kind === 'brain') {
    return all;
  }
  if (kind === 'brain' && workerRoles && workerRoles.length) {
    const base = workerRoles.includes('code')
      ? all.filter((t) => !HAND_OFF_TOOLS.has(t.function?.name))
      : all;
    if (!allowDispatch) return base;
    return base.concat(callWorkerTool(workerRoles));
  }
  return all;
}

// 搜索时跳过的二进制/大体积格式，避免把模型权重、压缩包整个读进内存
const SEARCH_SKIP_EXT = new Set([
  '.gguf', '.bin', '.safetensors', '.pt', '.onnx', '.exe', '.dll', '.so', '.dylib',
  '.zip', '.gz', '.tar', '.7z', '.rar', '.iso', '.pdf', '.mp4', '.mov', '.avi', '.mkv',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.woff', '.woff2', '.ttf'
]);
// 单个文件超过这个大小就不参与文本搜索
const SEARCH_MAX_BYTES = 1024 * 1024;

// [铆钉优化] 大文件不给整读：.unity 场景、prefab 动辄十几万行，整份塞给模型会卡死、上下文爆掉。
// 超过上限只返回体积、行数和开头几行，让模型用 search_text 搜定位、再按行号读片段。其他 AI 请勿删或调大到失去意义
const READ_FULL_MAX_BYTES = 256 * 1024;
const READ_UNITY_MAX_BYTES = 128 * 1024;
const READ_SPAN_MAX_LINES = 600;
const UNITY_SERIALIZED_EXT = new Set([
  '.unity', '.prefab', '.asset', '.mat', '.anim', '.controller', '.overridecontroller',
  '.physicmaterial', '.physicsmaterial2d', '.playable', '.mask', '.spriteatlas', '.terrainlayer', '.lighting'
]);

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.round(n / 1024)}KB`;
}

// 文件太大时返回给模型的说明；不大返回空串
function bigFileNote(abs) {
  let size = 0;
  try { size = fs.statSync(abs).size; } catch { return ''; }
  const ext = path.extname(abs).toLowerCase();
  const unity = UNITY_SERIALIZED_EXT.has(ext);
  if (size <= (unity ? READ_UNITY_MAX_BYTES : READ_FULL_MAX_BYTES)) return '';
  let total = 0;
  let head = [];
  if (size <= 400 * 1024 * 1024) {
    try {
      const span = readLineRange(abs, 1, 30);
      total = span.total;
      head = span.lines.map((ln, i) => `${i + 1}: ${String(ln).slice(0, 200)}`);
    } catch { /* 读不了就只报体积 */ }
  }
  const lines = [
    `【文件过大，没有整读】${abs}`,
    `体积 ${fmtBytes(size)}${total ? `，共 ${total} 行` : ''}。整份读完会卡死、撑爆上下文，禁止整读，也禁止分几十段把它读完。`,
    unity
      ? `这是 Unity 序列化文件（场景 / 预制体 / 资源，YAML 格式）。先用 search_text 定位：query 写 GameObject 名字、组件或脚本类名、m_Name、guid 或 fileID，path 填这个文件的完整路径，拿到行号后再用 read_file 的 startLine/endLine 读附近几十到几百行（一次最多 ${READ_SPAN_MAX_LINES} 行）。改场景里的对象引用和数值时优先改 C# 脚本或让用户在编辑器里改，不要大段改写场景文件。`
      : `先用 search_text 搜关键字（path 填这个文件的完整路径）拿到行号，再用 read_file 的 startLine/endLine 只读需要的那一段（一次最多 ${READ_SPAN_MAX_LINES} 行）。`,
    // [铆钉优化] 搜不到、不知道搜什么时直接找用户要，用户一般都会给（文字或截图）。其他 AI 请勿删
    '不知道该搜什么、搜不到、或者要看的是编辑器里的样子（Inspector 数值、层级、场景画面）时，直接调用 ask_user 找用户要：写清你要哪个对象、哪个组件、哪些字段，请用户粘贴那一段内容或截图发给你。用户可以在回答框里贴截图。'
  ];
  if (head.length) lines.push(`--- 开头 ${head.length} 行 ---\n${head.join('\n')}`);
  return lines.join('\n');
}

// 在单个大文件里逐行找关键字（流式读，不整份进内存），给 search_text 传文件路径时用
async function searchInFile(abs, query, signal) {
  const q = String(query || '').toLowerCase();
  if (!q) return '无匹配';
  const hits = [];
  const readline = require('readline');
  const stream = fs.createReadStream(abs, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  try {
    for await (const line of rl) {
      lineNo += 1;
      if (signal?.aborted) throw abortErr();
      if (line.toLowerCase().includes(q)) {
        hits.push(`${lineNo}: ${line.trim().slice(0, 200)}`);
        if (hits.length >= 60) break;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  if (!hits.length) return `${abs}\n无匹配`;
  return `${abs}（行号: 内容，最多 60 条）\n${hits.join('\n')}${hits.length >= 60 ? '\n…匹配太多，换更具体的关键字' : ''}`;
}
const FOREIGN_NOTE = '这是其他 AI 的技能或规则，SpCode 不读取。只使用本程序技能目录里已设置的技能。';

function ownSkillRoots(extra) {
  return (extra || []).filter((r) => {
    const n = path.resolve(r).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return n.endsWith('/skills') || n.endsWith('/.simple/skills') || n.endsWith('/.sinpo/skills');
  });
}

// [铆钉优化] 路径写错时按文件名在工作区里找同名文件，把真实位置告诉模型，不让它反复猜目录。其他 AI 请勿删除
function sameNameHint(workspace, extra, p) {
  const base = path.basename(String(p || '').replace(/\\/g, '/'));
  if (!base || !/\.\w+$/.test(base)) return '';
  const low = base.toLowerCase();
  const found = [];
  for (const root of [workspace, ...(extra || [])].filter(Boolean)) {
    if (!fs.existsSync(root)) continue;
    for (const f of listTree(root, { query: base, max: 20 })) {
      if (path.basename(f.path).toLowerCase() === low) found.push(path.join(root, f.path).replace(/\\/g, '/'));
    }
    if (found.length >= 5) break;
  }
  return found.length ? `同名文件在：\n${found.slice(0, 5).join('\n')}\n请改用上面的真实路径。` : '';
}

function searchText(root, query, globExt, signal) {
  const hits = [];
  const q = String(query || '').toLowerCase();
  let seen = 0;
  async function walk(dir, depth) {
    if (signal?.aborted) throw abortErr();
    if (hits.length >= 40 || depth > 8) return;
    let entries = [];
    try {
      // [铆钉优化] 用异步读目录和文件，搜索大工程时主进程不卡。其他 AI 请勿改回同步 readdirSync/readFileSync
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (hits.length >= 40) return;
      if (signal?.aborted) throw abortErr();
      if (SKIP.has(ent.name) || ent.name.startsWith('.')) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(abs, depth + 1);
      } else {
        if (globExt && !ent.name.toLowerCase().endsWith(globExt.toLowerCase())) continue;
        if (SEARCH_SKIP_EXT.has(path.extname(ent.name).toLowerCase())) continue;
        if (isForeignAiSkill(abs)) continue;
        try {
          if ((await fs.promises.stat(abs)).size > SEARCH_MAX_BYTES) continue;
          const text = await fs.promises.readFile(abs, 'utf8');
          if (text.includes('\u0000')) continue;
          const lines = text.split(/\r?\n/);
          lines.forEach((line, i) => {
            if (hits.length >= 40) return;
            if (line.toLowerCase().includes(q)) {
              hits.push(`${path.relative(root, abs).replace(/\\/g, '/')}:${i + 1}: ${line.trim().slice(0, 200)}`);
            }
          });
        } catch {
          /* 跳过无法读取的文件 */
        }
      }
      seen += 1;
    }
  }
  return walk(root, 0).then(() => hits.join('\n') || '无匹配');
}

async function execTool(workspace, snap, name, args, onEvent, extra, signal, lang, evidenceMeta) {
  extra = extra || [];
  if (name === 'mkdir') name = 'create_dir';
  if (name === 'list_dir') {
    const q = args.query || '';
    const skillRoots = ownSkillRoots(extra);
    const keep = (abs) => !isForeignAiSkill(abs, skillRoots);
    const target = String(args.path || '').trim();
    if (target) {
      const abs = resolveRead(workspace, extra, target);
      if (isForeignAiSkill(abs, skillRoots)) return FOREIGN_NOTE;
      const st = fs.statSync(abs);
      const dir = st.isDirectory() ? abs : path.dirname(abs);
      if (isForeignAiSkill(dir, skillRoots)) return FOREIGN_NOTE;
      const files = listTree(dir, { query: q, max: 400 }).filter((f) => keep(path.join(dir, f.path)));
      return files.map((f) => path.join(dir, f.path).replace(/\\/g, '/')).join('\n') || '(空目录)';
    }
    const chunks = [];
    if (workspace) {
      const files = listTree(workspace, { query: q, max: 300 }).filter((f) => keep(path.join(workspace, f.path)));
      chunks.push(files.map((f) => f.path).join('\n') || '(工作目录为空)');
    }
    for (const root of extra) {
      if (!fs.existsSync(root)) continue;
      const files = listTree(root, { query: q, max: 80 }).filter((f) => keep(path.join(root, f.path)));
      const lines = files.map((f) => path.join(root, f.path).replace(/\\/g, '/'));
      const insideWs = workspace && isInside(workspace, root);
      const tag = insideWs || /[\\/](skills|rules)$/i.test(root) ? '技能/规则' : '附加目录';
      chunks.push(`[${tag}] ${root.replace(/\\/g, '/')}\n${lines.join('\n') || '(空)'}`);
    }
    return chunks.join('\n\n') || '(空目录)';
  }
  if (name === 'read_file') {
    let abs;
    try {
      abs = resolveRead(workspace, extra, args.path);
    } catch (err) {
      const hint = sameNameHint(workspace, extra, args.path);
      if (hint) return `${err.message}\n${hint}`;
      throw err;
    }
    // [铆钉优化] 路径是文件夹时列出内容，不再报 EISDIR。其他 AI 请勿删除
    if (fs.statSync(abs).isDirectory()) {
      const files = listTree(abs, { max: 200 }).map((f) => f.path);
      return `【目录】${abs}（这是文件夹，不是文件，下面是里面的文件）\n${files.join('\n') || '(空目录)'}`;
    }
    if (isForeignAiSkill(abs, ownSkillRoots(extra))) {
      onEvent({ type: 'tool', name, status: 'done', detail: abs, text: '跳过其他 AI 的技能' });
      return `【文件】${abs}\n${FOREIGN_NOTE}`;
    }
    onEvent({ type: 'tool', name, status: 'running', detail: abs, text: `读取文件 ${abs}` });
    const ext = path.extname(abs).toLowerCase();
    if (isImageExt(ext)) {
      const text = await describeImageFile(abs, { signal, onEvent, lang });
      onEvent({ type: 'tool', name, status: 'done', detail: abs });
      return `【文件】${abs}\n${text}`;
    }
    if (isDocumentExt(ext)) {
      const parsed = await parseAttachment(abs, { signal });
      const note = parsed.images?.length
        ? `\n\n[文档内含 ${parsed.images.length} 张图。若已挂看图模型，请让用户把图作为附件发送，或把图片文件单独 read_file。]`
        : '';
      return `【文件】${abs}\n${parsed.text || ''}${note}`;
    }
    const sl = Number(args.startLine) || 0;
    let el = Number(args.endLine) || 0;
    if (sl > 0 || el > 0) {
      // [铆钉优化] 片段一次最多 READ_SPAN_MAX_LINES 行，防止 startLine=1、endLine=100000 变相整读大文件。其他 AI 请勿删
      const from = Math.max(1, sl || 1);
      let clipped = false;
      if (!el || el - from + 1 > READ_SPAN_MAX_LINES) {
        clipped = !!el || fs.statSync(abs).size > READ_FULL_MAX_BYTES;
        el = clipped ? from + READ_SPAN_MAX_LINES - 1 : 0;
      }
      const span = readLineRange(abs, from, el);
      if (span.start > span.total || (el > 0 && from > el) || span.start > span.end) {
        return `【文件】${abs}\n[行范围无效：文件共 ${span.total} 行]`;
      }
      const body = span.lines.map((ln, i) => `${span.start + i}: ${ln}`).join('\n');
      const more = clipped && span.end < span.total
        ? `\n[一次最多读 ${READ_SPAN_MAX_LINES} 行，已只给到第 ${span.end} 行。需要后面的内容再按行号读下一段]`
        : '';
      return `【文件】${abs} 第 ${span.start}-${span.end} 行 / 共 ${span.total} 行\n` + body + more;
    }
    const bigNote = bigFileNote(abs);
    if (bigNote) {
      onEvent({ type: 'tool', name, status: 'done', detail: abs, text: `文件过大，不整读 ${abs}` });
      return bigNote;
    }
    const loaded = readTextFile(abs);
    if (loaded.binary) return `【文件】${abs}\n二进制文件，没有文本正文`;
    const totalLines = loaded.text ? loaded.text.split(/\r?\n/).length : 0;
    return `【文件】${abs} 全文 / 共 ${totalLines} 行\n` + loaded.text;
  }
  if (name === 'write_file') {
    const rel = String(args.path).replace(/\\/g, '/');
    const abs = resolveWrite(workspace, extra, rel);
    const content = String(args.content ?? '');
    const inWs = workspace && isInside(workspace, abs);
    diag.log('tool', '开始写文件', { path: abs, bytes: Buffer.byteLength(content, 'utf8'), inWs: !!inWs });
    try {
      if (inWs) {
        const wsRel = path.relative(workspace, abs).replace(/\\/g, '/');
        if (!snap.current) snap.current = snapshot.create(workspace, '自动更改快照');
        snapshot.recordChange(workspace, snap.current, wsRel, 'write');
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
      if (snap) snap.wroteFiles = (snap.wroteFiles || 0) + 1;
    } catch (err) {
      diag.log('tool', '写文件失败', { path: abs, message: err && err.message, stack: err && err.stack });
      throw err;
    }
    diag.log('tool', '写文件完成', { path: abs });
    onEvent({ type: 'tool', name, status: 'done', detail: abs });
    // 增量更新项目地图：只重抽这一个文件的符号与依赖，行号立刻跟上，不重建整图
    try { codeIndex.upsertFile(workspace, abs, extra); } catch (err) { diag.log('map', '写文件后更新地图失败', { path: abs, message: err && err.message }); }
    return `已写入 ${abs}`;
  }
  if (name === 'edit_file') {
    let abs;
    try {
      abs = resolveWrite(workspace, extra, String(args.path || '').replace(/\\/g, '/'));
    } catch (err) {
      const hint = sameNameHint(workspace, extra, args.path);
      throw new Error(hint ? `${err.message}\n${hint}` : err.message);
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      const hint = sameNameHint(workspace, extra, args.path);
      return `文件不存在：${abs}。新建文件请用 write_file。${hint ? `\n${hint}` : ''}`;
    }
    const oldStr = String(args.old_string ?? '');
    const newStr = String(args.new_string ?? '');
    if (!oldStr) return 'old_string 为空。新建或整份重写请用 write_file。';
    if (oldStr === newStr) return 'old_string 与 new_string 相同，没有改动。';
    const buf = fs.readFileSync(abs);
    const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    const text = buf.toString('utf8').replace(/^\uFEFF/, '');
    const crlf = /\r\n/.test(text);
    // 统一按 LF 匹配，写回时恢复原换行符，模型给的 old_string 是 LF 还是 CRLF 都能对上
    const body = text.replace(/\r\n/g, '\n');
    const find = oldStr.replace(/\r\n/g, '\n');
    const repl = newStr.replace(/\r\n/g, '\n');
    let count = body.split(find).length - 1;
    let target = find;
    if (!count) {
      // 常见偏差：行尾空白不同。按去掉行尾空白后再找一次，且必须唯一
      const trimEnd = (s) => s.split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n');
      const lines = body.split('\n');
      const endsNl = find.endsWith('\n');
      const want = trimEnd(endsNl ? find.slice(0, -1) : find).split('\n');
      const hits = [];
      for (let i = 0; i + want.length <= lines.length; i++) {
        let ok = true;
        for (let j = 0; j < want.length; j++) {
          if (lines[i + j].replace(/[ \t]+$/, '') !== want[j]) { ok = false; break; }
        }
        if (ok) hits.push(i);
      }
      if (hits.length === 1) {
        target = lines.slice(hits[0], hits[0] + want.length).join('\n') + (endsNl ? '\n' : '');
        count = 1;
      }
    }
    if (!count) {
      return `没找到 old_string：${abs}。old_string 必须与文件内容逐字一致（含缩进），不要带 read_file 的行号前缀。先 read_file 这一段再照抄。`;
    }
    if (count > 1 && !args.replace_all) {
      return `old_string 在 ${abs} 里出现了 ${count} 次，没有改动。请多带几行上下文让它唯一，或设 replace_all=true。`;
    }
    const nextBody = args.replace_all ? body.split(target).join(repl) : body.replace(target, () => repl);
    const out = (bom ? '\uFEFF' : '') + (crlf ? nextBody.replace(/\n/g, '\r\n') : nextBody);
    const inWs = workspace && isInside(workspace, abs);
    diag.log('tool', '开始局部替换', { path: abs, count: args.replace_all ? count : 1, inWs: !!inWs });
    try {
      if (inWs) {
        const wsRel = path.relative(workspace, abs).replace(/\\/g, '/');
        if (!snap.current) snap.current = snapshot.create(workspace, '自动更改快照');
        snapshot.recordChange(workspace, snap.current, wsRel, 'write');
      }
      fs.writeFileSync(abs, out, 'utf8');
      if (snap) snap.wroteFiles = (snap.wroteFiles || 0) + 1;
    } catch (err) {
      diag.log('tool', '局部替换失败', { path: abs, message: err && err.message });
      throw err;
    }
    onEvent({ type: 'tool', name, status: 'done', detail: abs });
    try { codeIndex.upsertFile(workspace, abs, extra); } catch (err) { diag.log('map', '改文件后更新地图失败', { path: abs, message: err && err.message }); }
    return `已修改 ${abs}（替换 ${args.replace_all ? count : 1} 处）`;
  }
  if (name === 'create_dir') {
    const rel = String(args.path || args.dir || '').replace(/\\/g, '/').trim();
    if (!rel) throw new Error('路径为空');
    const abs = resolveAllowed(workspace, extra, rel);
    diag.log('tool', '开始创建目录', { path: abs });
    try {
      if (fs.existsSync(abs)) {
        const st = fs.statSync(abs);
        if (!st.isDirectory()) throw new Error('路径已存在且不是文件夹：' + abs);
        onEvent({ type: 'tool', name, status: 'done', detail: abs });
        onEvent({ type: 'files', changes: [{ path: rel, action: 'mkdir' }] });
        return `目录已存在 ${abs}`;
      }
      fs.mkdirSync(abs, { recursive: true });
    } catch (err) {
      diag.log('tool', '创建目录失败', { path: abs, message: err && err.message });
      throw err;
    }
    diag.log('tool', '创建目录完成', { path: abs });
    onEvent({ type: 'tool', name, status: 'done', detail: abs });
    onEvent({ type: 'files', changes: [{ path: rel, action: 'mkdir' }] });
    return `已创建目录 ${abs}`;
  }
  if (name === 'delete_file') {
    const rel = String(args.path).replace(/\\/g, '/');
    const abs = resolveAllowed(workspace, extra, rel);
    const inWs = workspace && isInside(workspace, abs);
    diag.log('tool', '开始删文件', { path: abs, inWs: !!inWs });
    try {
      if (inWs) {
        const wsRel = path.relative(workspace, abs).replace(/\\/g, '/');
        if (!snap.current) snap.current = snapshot.create(workspace, '自动更改快照');
        snapshot.recordChange(workspace, snap.current, wsRel, 'delete');
      }
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch (err) {
      diag.log('tool', '删文件失败', { path: abs, message: err && err.message, stack: err && err.stack });
      throw err;
    }
    diag.log('tool', '删文件完成', { path: abs });
    onEvent({ type: 'tool', name, status: 'done', detail: abs });
    try { codeIndex.removeFile(workspace, abs, extra); } catch (err) { diag.log('map', '删文件后更新地图失败', { path: abs, message: err && err.message }); }
    return `已删除 ${abs}`;
  }
  if (name === 'search_text') {
    const target = String(args.path || '').trim();
    let dirOk = '';
    if (target) {
      // [铆钉优化] 给的搜索范围不存在时改搜整个工作区，不再直接报 ENOENT 让模型空转。其他 AI 请勿删除
      try {
        const abs = resolveRead(workspace, extra, target);
        // [铆钉优化] path 是单个文件时只在这个文件里流式搜，大场景文件也能拿到行号（目录搜索会跳过 1MB 以上的文件）。其他 AI 请勿删
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
          onEvent({ type: 'tool', name, status: 'running', detail: abs, text: `在 ${path.basename(abs)} 里搜索 ${String(args.query || '').slice(0, 40)}` });
          return await searchInFile(abs, args.query || '', signal);
        }
        if (fs.existsSync(abs)) dirOk = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
      } catch { /* 落到整个工作区 */ }
    }
    if (dirOk) return searchText(dirOk, args.query || '', args.glob || '', signal);
    const miss = target ? `（范围 ${target} 不存在，已改搜整个工作区）\n` : '';
    if (miss) {
      const res = workspace ? await searchText(workspace, args.query || '', args.glob || '', signal) : '无匹配';
      return miss + res;
    }
    const parts = [];
    if (workspace) parts.push(await searchText(workspace, args.query || '', args.glob || '', signal));
    for (const root of extra) {
      if (!root || !fs.existsSync(root)) continue;
      if (workspace && isInside(workspace, root)) continue;
      if (/[\\/](skills|rules)$/i.test(root)) continue;
      const block = await searchText(root, args.query || '', args.glob || '', signal);
      if (block && block !== '无匹配') parts.push(`[${root.replace(/\\/g, '/')}]\n${block}`);
    }
    const merged = parts.filter((p) => p && p !== '无匹配').join('\n\n');
    return merged || '无匹配';
  }
  if (name === 'semantic_search') {
    const q = String(args.query || '').trim();
    if (!q) return '查询为空';
    const target = String(args.path || '').trim();
    let within = '';
    if (target) {
      const abs = resolveRead(workspace, extra, target);
      within = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
    }
    onEvent({ type: 'tool', name, status: 'running', detail: q, text: `语义检索 ${q}` });
    return codeEmbed.search(workspace, extra, { query: q, within, limit: args.limit, signal });
  }
  if (name === 'goto_definition') {
    const symbol = String(args.symbol || args.name || args.query || '').trim();
    onEvent({ type: 'tool', name, status: 'running', detail: symbol, text: `跳转到定义 ${symbol}` });
    return codeIndex.gotoDefinition(workspace, extra, symbol);
  }
  if (name === 'map_lookup') {
    const q = String(args.query || '').trim();
    const mod = String(args.module || '').trim();
    if (!q && !mod) return '查询为空';
    const target = String(args.path || '').trim();
    let within = '';
    if (target) {
      const abs = resolveRead(workspace, extra, target);
      within = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
    }
    onEvent({ type: 'tool', name, status: 'running', detail: mod || q, text: `查项目地图 ${mod || q}` });
    return codeIndex.search(workspace, extra, {
      query: q,
      module: mod,
      within,
      limit: args.limit,
      signal
    });
  }
  if (name === 'memory_list') {
    if (!workspace) return '请先打开项目';
    const items = memory.list(workspace);
    if (!items.length) return '（暂无项目记忆）';
    return items.map((e) => {
      const pin = e.pinned ? ' [钉住]' : '';
      const paths = (e.paths || []).length ? ` · ${(e.paths || []).join(', ')}` : '';
      return `${e.id}${pin} (${e.kind}) ${e.summary}${paths}`;
    }).join('\n');
  }
  if (name === 'memory_add') {
    if (!workspace) throw new Error('请先打开项目');
    const added = memory.addUserMemory(workspace, {
      summary: args.summary,
      paths: args.paths,
      tags: args.tags,
      pinned: args.pinned !== false
    });
    onEvent({ type: 'tool', name, status: 'done', detail: 'memory' });
    return `已写入记忆 ${added.map((e) => e.id).join(', ')}`;
  }
  if (name === 'memory_forget') {
    if (!workspace) throw new Error('请先打开项目');
    memory.remove(workspace, args.id);
    onEvent({ type: 'tool', name, status: 'done', detail: args.id });
    return `已删除记忆 ${args.id}`;
  }
  if (name === 'working_memory_update') {
    const err = new Error('WORKING_MEMORY_UPDATE');
    err.code = 'working_memory_update';
    err.patch = {
      goal: args.goal,
      openQuestions: args.openQuestions,
      focusPaths: args.focusPaths,
      scratch: args.scratch,
      addScratch: args.addScratch,
      addQuestion: args.addQuestion
    };
    throw err;
  }
  if (name === 'ask_user') {
    const err = new Error('ASK_USER');
    err.code = 'ask_user';
    err.ask = {
      question: String(args.question || '').trim(),
      options: Array.isArray(args.options) ? args.options.map(String).filter(Boolean).slice(0, 8) : [],
      allowFreeText: args.allowFreeText !== false
    };
    if (!err.ask.question) throw new Error('ask_user 需要 question');
    throw err;
  }
  if (name === 'brain_pressure') {
    return '已在后台记录。不要向用户提到压力，直接回答用户的问题。';
  }
  if (name === 'generate_media') {
    const role = GEN_KIND_ROLE[String(args.kind || 'image').toLowerCase()];
    if (!role) return `kind 只能是 ${Object.keys(GEN_KIND_ROLE).join(' / ')}`;
    const prompt = String(args.prompt || '').trim();
    if (!prompt) return 'prompt 不能为空，请写完整的生成描述。';
    onEvent({ type: 'tool', name, status: 'running', detail: prompt.slice(0, 120), text: `生成 ${prompt.slice(0, 60)}` });
    const r = await generateRole({ vs: store.load(), role, prompt, workspace, extra, onEvent, signal, snap, lang });
    onEvent({ type: 'tool', name, status: 'done', detail: r.rel || '', text: r.ok ? `已生成 ${r.rel}` : `${r.roleName}失败` });
    if (!r.ok) return `【${r.roleName}失败】${r.detail}`;
    if (role === 'docGen') return `【${r.roleName}已完成】文件：${r.rel}\n\n${String(r.text || '').slice(0, 8000)}`;
    return `【${r.roleName}已完成】文件在工作目录：${r.rel}。向用户报告这个路径，不要说还没生成。`;
  }
  if (name === 'run_command') {
    const s = store.load();
    if (s.commandSandbox?.enabled === false) {
      return '命令沙盒已关闭，无法执行 shell。请在设置中开启「命令沙盒」。';
    }
    if (!workspace) throw new Error('请先打开项目');
    const command = String(args.command || '').trim();
    if (!command) throw new Error('command 不能为空');
    if (typecheck.isUnity(workspace) && typecheck.isUnityBlockedCommand(command)) {
      return '这是 Unity 工程，这条命令没有执行：这里不能跑测试、不能启动 Unity，也不能用 git。请只对照代码和需求是否一致。运行效果由用户在编辑器里看，不要再尝试这类命令。';
    }
    if (desktopOn() && shellLaunchesApp(command)) {
      return '这条命令没有执行。AGI 已打开，打开软件和网页请用键鼠：先 screen_read，再用 keyboard_key（如 Win+R）、keyboard_type、mouse_click 或 ui_act。不要用 run_command 执行 start、Start-Process，也不要直接启动 chrome.exe。';
    }
    const timeoutMs = Math.max(3, Number(s.commandSandbox?.timeoutSec) || 60) * 1000;
    onEvent({ type: 'tool', name, status: 'running', detail: command.slice(0, 120), text: `沙盒命令 ${command.slice(0, 120)}` });
    diag.log('sandbox', '执行命令', { command: command.slice(0, 200), cwd: args.cwd || '.' });
    const beforeScan = snapshot.scanFingerprints(workspace);
    if (!snap.current) snap.current = snapshot.create(workspace, '自动更改快照');
    const pre = snapshot.preBackupWorkspace(workspace, snap.current);
    if (!pre.complete || !beforeScan.scanStatus?.complete || pre.truncated || beforeScan.truncated) {
      diag.log('sandbox', '命令快照扫描不完整', { backed: pre.backed, max: 8000, preErrors: pre.errors?.length || 0, scanErrors: beforeScan.scanStatus?.errors?.length || 0 });
    }
    const result = await sandbox.runSandboxed({
      command,
      workspace,
      cwd: args.cwd || '.',
      timeoutMs,
      signal
    });
    const afterScan = snapshot.scanFingerprints(workspace);
    const cmdChanges = snapshot.recordCommandDiff(workspace, snap.current, beforeScan, afterScan, pre);
    if (cmdChanges.length) {
      diag.log('sandbox', '命令改动已记入快照', { count: cmdChanges.length, paths: cmdChanges.slice(0, 12).map((c) => c.path) });
      onEvent({
        type: 'files',
        snapshotId: snap.current.id,
        changes: snap.current.manifest.changes
      });
    }
    diag.log('sandbox', '命令结束', {
      code: result.code,
      timedOut: result.timedOut,
      blocked: !!result.blocked,
      out: (result.stdout || '').length,
      err: (result.stderr || '').length,
      tracked: cmdChanges.length
    });
    return sandbox.formatResult(result);
  }
  if (DESKTOP_TOOLS.has(name)) {
    const desktopHand = require('./desktop-hand');
    if (!desktopHand.isAlive()) return '「AGI」没开，不能看屏幕或操作鼠标键盘。';
    if (name === 'screen_read') {
      const screenText = require('./screen-text-map');
      const wait = Math.max(0, Math.min(10000, Number(args.wait_ms) || 0));
      onEvent({ type: 'tool', name, status: 'running', text: wait ? `等 ${wait}ms 后识别屏幕文字` : '识别屏幕文字' });
      if (wait) await new Promise((r) => setTimeout(r, wait));
      desktopHand.hold();
      try {
        return screenText.formatBlock(await screenText.observe({ threshold: 0 }));
      } catch (err) {
        return `识别屏幕失败：${err && err.message ? err.message : err}`;
      }
    }
    if (name === 'ui_act') return guardDesktop(name, args, () => desktopHand.uiAct(args.id, args.action, args.text));
    if (name === 'agi_note') {
      const frame = require('./screen-text-map').lastFrame();
      const app = args.app || (frame && frame.target && frame.target.proc) || '';
      return require('./agi-memory').add(app, args.note);
    }
    if (name === 'window_list') return desktopHand.windowList();
    if (name === 'window_focus') return desktopHand.windowFocus(args.title);
    if (name === 'screen_look') {
      onEvent({ type: 'tool', name, status: 'running', text: '全屏截图并识别屏幕文字（本地 OCR）' });
      const shot = await desktopHand.captureScreen();
      if (!shot.ok) return shot.message;
      return `${shot.text || '【屏幕文字】本地 OCR 未能返回识别结果。'}\n截图已保存：${shot.path}\n画面 ${shot.frameId || ''} ${shot.width}×${shot.height}，左上角 0,0 对应系统坐标 (${shot.originX}, ${shot.originY})。`;
    }
    if (name === 'clipboard_look') {
      onEvent({ type: 'tool', name, status: 'running', text: '读取剪贴板图片' });
      const shot = desktopHand.importClipboardImage();
      if (!shot.ok) return shot.message;
      let seen = '';
      try {
        seen = await describeImageFile(shot.path, { signal, onEvent, lang });
        shot.path = desktopHand.nameSightFile(shot.path, seen);
      } catch (err) {
        seen = err && err.message ? err.message : '看图失败';
      }
      return `【视力】已从剪贴板保存 ${shot.path}\n${seen}`;
    }
    if (name === 'mouse_move') return desktopHand.moveTo(args.x, args.y);
    if (name === 'mouse_click') return guardDesktop(name, args, () => desktopHand.clickAt(args.x, args.y, args.button, args.times || (args.double ? 2 : 1)));
    if (name === 'mouse_drag') return desktopHand.dragStroke(args.points, args.button);
    if (name === 'mouse_scroll') return desktopHand.scrollAt(args.x, args.y, args.delta);
    if (name === 'keyboard_type') return guardDesktop(name, args, () => desktopHand.typeText(args.text));
    return guardDesktop(name, args, () => desktopHand.tapKeys(args.key || args.combo));
  }
  return `未知工具：${name}`;
}

function fileStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function writeGeneratedFile(workspace, extra, snap, rel, data, encoding) {
  if (!workspace) throw new Error('请先打开项目，生成的文件才能保存到工作目录。');
  const abs = resolveAllowed(workspace, extra, rel);
  const inWs = isInside(workspace, abs);
  if (inWs) {
    const wsRel = path.relative(workspace, abs).replace(/\\/g, '/');
    if (!snap.current) snap.current = snapshot.create(workspace, '自动更改快照');
    snapshot.recordChange(workspace, snap.current, wsRel, 'write');
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (encoding === 'utf8') fs.writeFileSync(abs, data, 'utf8');
  else fs.writeFileSync(abs, data);
  return path.relative(workspace, abs).replace(/\\/g, '/');
}

/**
 * 生图/生视频/生3D/生文档：组合优先，否则全局能力默认 + fallback。一次只做一种
 * @returns {Promise<{ ok: boolean, roleName: string, rel?: string, text?: string, detail?: string }>}
 */
async function generateRole({ vs, role, prompt, workspace, extra, onEvent, signal, snap, lang }) {
  const roleName = (assembly.ROLES.find((x) => x.id === role) || {}).name || role;
  const candidates = assembly.roleCandidates(vs, role);
  if (!candidates.length) {
    const tip = `未配置${roleName}模型（组合或全局能力默认）。请在「文件→模型组合」添加${roleName}槽位并挂上本地 GGUF 或接口模型。`;
    onEvent({ type: 'think', text: tip });
    return { ok: false, roleName, detail: tip };
  }
  const errors = [];
  for (const cand of candidates) {
    const helperCfg = assembly.slotToModelCfg(cand.slot, vs);
    if (!helperCfg) continue;
    const helperLabel = helperCfg.model || helperCfg.name || roleName;
    const srcHint = cand.source === 'assembly' ? '组合'
      : cand.source === 'local-auto' ? '本地自动'
        : (cand.source === 'fallback' ? '备用' : '全局');
    onEvent({
      type: 'status',
      text: `正在用${roleName}模型 ${helperLabel}（${srcHint}）生成…`,
      activeModel: helperLabel,
      activeRole: role
    });
    diag.log('agent', '路由到生成槽位', { role, model: helperLabel, source: cand.source });
    try {
      if (role === 'docGen') {
        const msg = await completeWithFallback({
          modelCfg: helperCfg,
          messages: [
            { role: 'system', content: assembly.helperPrompt(role, lang) },
            { role: 'user', content: String(prompt || '').slice(0, 24000) || '请写一份文档' }
          ],
          noTools: true,
          signal,
          onDelta: () => {},
          onWait: (sec) => onEvent({
            type: 'status',
            text: `${roleName}模型处理中 · ${sec}`,
            activeModel: helperLabel,
            activeRole: role
          })
        });
        const out = String(msg?.content || '').trim();
        if (!out) throw new Error('文档模型没有返回内容');
        const rel = writeGeneratedFile(workspace, extra, snap, `generated/doc-${fileStamp()}.md`, out, 'utf8');
        onEvent({ type: 'think', text: `已生成文档 ${rel}` });
        return { ok: true, roleName, rel, text: out };
      }
      const asset = await generate.generateMedia({
        role,
        modelCfg: helperCfg,
        prompt,
        signal,
        modelsDir: vs.modelsDir || store.defaultModelsDir(),
        onWait: (text) => onEvent({ type: 'status', text })
      });
      const rel = writeGeneratedFile(
        workspace,
        extra,
        snap,
        `generated/${role}-${fileStamp()}${asset.ext || '.bin'}`,
        asset.buf
      );
      onEvent({ type: 'think', text: `已生成文件 ${rel}` });
      return { ok: true, roleName, rel };
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      errors.push(`[${srcHint}·${helperLabel}] ${e.message}`);
      onEvent({ type: 'think', text: `${roleName}（${srcHint}·${helperLabel}）失败：${e.message}` });
      diag.log('agent', '生成槽位失败，尝试下一候选', { role, source: cand.source, message: e && e.message });
    }
  }
  const detail = errors.join('；') || '无可用模型';
  let hint = '';
  if (role === 'imageGen' && errors.some((e) => /组合|本地自动/.test(e))) {
    hint = '聊天模型与生图模型是分开的，这次没有使用聊天接口。上面的原文是本地生图引擎或配套文件（VAE / 文本编码器）下载或运行失败。请原样转述这段原文，不要把它说成聊天 API 的 401，也不要建议用户去改聊天模型的 key。';
  } else if (role === 'imageGen') {
    hint = '没有走本地生图。请在「文件→模型组合→生图」挂本地 GGUF，不要把聊天接口填进生图槽。';
  }
  return { ok: false, roleName, detail: hint ? `${detail}。${hint}` : detail };
}

// generate_media 工具的 kind 对应的生成槽位
const GEN_KIND_ROLE = { image: 'imageGen', video: 'videoGen', '3d': 'model3d', doc: 'docGen' };

/**
 * 只给不会调用工具的本地引擎（zbaing）用：按用户原话在开口前自动生成。
 * 能调用工具的模型改由大脑自己调用 generate_media，提示词由大脑整理
 */
async function runGenerateSlots({ vs, userText, workspace, extra, extraTexts, onEvent, signal, snap, lang }) {
  const wanted = assembly.detectRoles(userText, { hasImages: false, contextChars: 0 })
    .filter((r) => assembly.GEN_ROLE_IDS.includes(r));
  for (const role of wanted) {
    const r = await generateRole({ vs, role, prompt: userText, workspace, extra, onEvent, signal, snap, lang });
    if (r.ok && role === 'docGen') {
      extraTexts.push(`—— 以下是${r.roleName}模型已写入的文档 ——`);
      extraTexts.push(`文件：${r.rel}\n\n${String(r.text || '').slice(0, 8000)}`);
    } else if (r.ok) {
      extraTexts.push(`—— ${r.roleName}已完成，文件在工作目录：${r.rel}。请据此继续回答用户，不要说还没生成。 ——`);
    } else {
      extraTexts.push(`【${r.roleName}失败】${r.detail}`);
    }
  }
}

function buildSystemPrompt({
  workspace, rules, skill, extra, allSkills, persona, visionMode, visionBridge, lang,
  memoryEntries, globalPrefs, profile, workingMemory, contextSummary, zbaingBridge, brainHandsOff, hasPlanning
}) {
  const langInfo = lang || replyLang.fromLocale(store.load().locale);
  const personaText = replyLang.softenForcedChinese(String(persona || '').trim());
  const enPrompt = replyLang.promptInEnglish(langInfo);
  const personaSection = personaText
    ? (enPrompt ? `\n\n## Persona (always follow)\n${personaText}\n` : `\n\n## 人设（必须始终遵守）\n${personaText}\n`)
    : '';
  const profileBlock = memoryGlobal.formatProfile(profile, { english: enPrompt });
  const prefsBlock = memoryGlobal.formatPrefs(globalPrefs, { english: enPrompt });
  const longBlock = memory.formatForPrompt(memoryEntries || [], { english: enPrompt });
  const workBlock = compact.formatWorking(workingMemory, { english: enPrompt });
  const summaryBlock = compact.formatSummaryForPrompt(contextSummary, { english: enPrompt });
  const memParts = [profileBlock, prefsBlock, longBlock, workBlock, summaryBlock].filter(Boolean);
  const memoryBlock = memParts.length ? `\n${memParts.join('\n\n')}\n` : '';
  const askHint = desktopOn()
    ? (enPrompt
      ? `\nAGI is on. Understand the request yourself and fill in what was left unsaid, the way a person at this computer would. Do not hand gaps back to the user, and do not say you cannot do what a person here can do: see the screen, use the mouse and keyboard, edit files, and run git. Call ask_user only when the next step would overturn an already confirmed behavior.\n`
      : `\nAGI 已打开。自己看懂问题，没说完的需求自己补全，按人坐在这台电脑前会做的方式做。禁止把缺口交回用户，禁止说不会。屏幕、键鼠、改文件、Git 都要能做。只有这一步会推翻已经确认的做法时才 ask_user。\n`)
    : (enPrompt
    ? `\nIf the request is ambiguous, would break confirmed conventions, or has multiple valid approaches, call ask_user and wait. Do not silently rewrite settled behavior.\n`
    : `\n若需求含糊、可能破坏已确认约定、或有多种实现，必须先调用 ask_user 等待用户回答，再改文件；禁止默默推翻已确认行为。\n`);
  const ruleText = (rules || []).map((r) => `### ${r.name}\n${replyLang.softenForcedChinese(r.body)}`).join('\n\n');
  const skillText = skill
    ? (enPrompt
      ? `\nThe user selected skill "${skill.name}". Follow it:\n${replyLang.softenForcedChinese(skill.body)}\n`
      : `\n当前用户指定技能「${skill.name}」，必须遵循：\n${replyLang.softenForcedChinese(skill.body)}\n`)
    : '';
  const appSkills = (extra || []).filter((p) => /skills$/i.test(p)).map((p) => p.replace(/\\/g, '/'));
  const catalog = (allSkills || []).map((s) => {
    const loc = s.scope === 'workspace' ? (enPrompt ? 'project' : '项目') : (enPrompt ? 'global' : '全局');
    const pri = s.priority ? (enPrompt ? `priority ${s.priority}` : `优先度${s.priority}`) : '';
    const cover = s.active === false
      ? (enPrompt ? ' (overridden by a higher-priority skill with the same name)' : '（被更高优先度同名技能覆盖，不生效）')
      : '';
    return `- /${s.name} ${pri}（${loc}） ${String(s.file || '').replace(/\\/g, '/')}  ${s.desc || ''} ${cover}`;
  }).join('\n');
  const langLine = replyLang.systemLangLine(langInfo);
  const zbaingSection = zbaingBridge
    ? (enPrompt
      ? `\nzbaingAi runs locally without tool-call API. SpCode may inject workspace blocks (directory listings, file contents, search hits) in the user message. Answer from those blocks. Do not say you cannot read files or access the project.\n`
      : `\nzbaingAi 为本地引擎，不走工具调用接口。SpCode 会在用户消息里注入【工作区目录】【文件名】等块。你必须根据这些材料回答，禁止说自己无法读文件、无法访问项目或只能处理对话文字。\n`)
    : '';
  let visionSection = '';
  if (visionMode === 'helper' || visionMode === 'mixed') {
    visionSection += enPrompt
      ? `\nVision combo is on (${visionBridge}). Recognized images appear as text under "image recognition result". Answer from that text. Do not say you cannot see images.\n`
      : `\n已启用看图组合（${visionBridge}）。已识别的图片结果写在用户消息里的「图片识别结果」段。你必须根据这些文字回答画面内容，禁止说自己看不到图、没有看图工具或看图通道未接通。\n`;
  }
  if (visionMode === 'native' || visionMode === 'mixed') {
    visionSection += enPrompt
      ? `\nThis message includes original images. Look at the image_url parts and answer what is in the picture. Do not say you cannot see images.\n`
      : `\n本条消息里带有原图（image_url）。请直接根据画面回答，禁止说自己看不到图或没有看图通道。\n`;
  }
  const agiOn = desktopOn();
  const agiSelfEn = '\nAGI is on. The user only accepts the result. You finish everything else yourself: understand the request, fill the gaps, read the screen, use the mouse and keyboard, edit files, run git, and run project commands. Do not wait for start, do not restate and stop, and do not hand work back. Your permissions are high. This turn is unlimited. Call screen_read first, then ui_act or the mouse and keyboard, then edit_file, write_file, or run_command as needed. Open apps and web pages with the keyboard and mouse only. Do not use run_command to run start, Start-Process, or chrome.exe. Do not call call_worker. When it is done, tell the user what to check.\n';
  const agiSelfZh = '\nAGI 已打开。用户只管验收，其他所有事情都由你自己做完：看懂问题、补全需求、看屏幕、键鼠、改文件、Git、在项目里执行命令。不要等「开始」，不要复述完就停，不要把活交回用户。你的权限现在很高，基本上能干所有事情。这一轮全解放，不受思考轮次限制。必须先调用 screen_read，看完再用 ui_act 或键鼠，需要改文件或跑命令就自己调用 edit_file、write_file、run_command。打开软件和网页只用键鼠，禁止用 run_command 执行 start、Start-Process 或启动 chrome.exe。禁止 call_worker，禁止派单。做完后只告诉用户验收什么。\n';
  const handoff = agiOn
    ? (enPrompt ? agiSelfEn : agiSelfZh)
    : (brainHandsOff
    ? (enPrompt
      ? `\nYou are the brain. Read, search, and decide the design. File writes, deletes, new folders, and shell commands must go through call_worker with role "code". The task is the spec the implementer must follow. Include: file paths, method names and the line numbers you already read, current behavior, the exact target behavior step by step, and what must stay unchanged. A one-line request is rejected. Do not call write_file, delete_file, create_dir, or run_command yourself. When several files do not depend on each other, emit multiple call_worker calls with role "code" in the same reply, one file group per task. They run at the same time. Keep the same file or dependent edits in one task. If the user has not said start / 开始 / 动手 / 干吧 this turn, do not call call_worker and do not edit files. Restate the goal, scope, constraints, and acceptance, then end with: 确认无误后回复「开始」，我再动手. Then stop. A plain question can be answered without waiting. After the user says start, do not talk to the user until the files are written. If the worker stops, cannot find something, or does not know how, put the paths and the exact text you already read into a new task and call_worker again. Only after the files match the request may you report. If it is right, say you did it. If a subordinate wrote it wrong along the way, name planning or code in that final report. Do not say a file was changed if it was not written.\n`
      : `\n你是大脑。查资料和定方案由你完成。改文件、删文件、建目录、执行命令必须调用 call_worker，role 填 code。task 就是实现模型必须照做的设计，写全这些内容：要改的文件路径、相关方法名和你读到的行号、现在的行为、要改成的行为（逐步写清）、明确不要改的范围。禁止只写「修一下」这种一句话，这种任务会被退回、不会执行。禁止自己调用 write_file、delete_file、create_dir、run_command。多个文件互不依赖时，同一轮发出多条 call_worker，role 都填 code，每条只改自己的文件，程序会同时做。同一个文件或有依赖的改动仍合成一条。「开始」只约束你（大脑）。用户本轮没有说「开始 / 动手 / 干吧 / start」时，禁止调用 call_worker，禁止改文件。先简洁复述目标、范围、约束、验收，结尾必须写：确认无误后回复「开始」，我再动手。然后停住。提问、讲现象、报 bug 由你自己查资料并回答，禁止派给代码，也不要让用户先说开始。只读可以。用户本轮已经说了「开始」时，禁止再复述、禁止再讨论、禁止再写「确认无误后回复开始」「请回复开始」「我再动手」，立刻 call_worker 干活。实现模型和总结模块不判断「开始」，你派过去他们就必须做。实现模型返回后，做完之前禁止向用户交中间结果、禁止解释失败、禁止道歉。部下说不会、找不到、停止，你用已经读到的绝对路径和内容把改法写进 task，立刻再派 call_worker，role 填 code，直到文件按需求写入。只有文件已经按需求改完，才向用户说结果。做对了向用户说是你做成的。中途若是部下写错，完成说明里点名是规划还是代码。短说明里提到、但没有写入的文件，禁止说已经改了。派给代码的路径用你已经读到的绝对路径。禁止说执行环境找不到已经读到的文件，禁止要求用户把目录加进工作区。\n`)
    : '');
  const unityProject = !!(workspace && typecheck.isUnity(workspace));
  // [铆钉优化] 改已有文件首选 edit_file；Windows 命令走 cmd.exe，写明免得模型用 bash/PowerShell 语法反复失败。其他 AI 请勿删除
  const winShellEn = process.platform === 'win32' ? ' run_command runs in Windows cmd.exe: no bash syntax (heredoc, find -type), wrap PowerShell as powershell -NoProfile -Command "...".' : '';
  const winShellZh = process.platform === 'win32' ? '。run_command 在 Windows cmd.exe 里执行：不支持 bash 语法（<<EOF、find -type），PowerShell 要写成 powershell -NoProfile -Command "..."' : '';
  const shellUseEn = (unityProject
    ? 'This is a Unity project. Do not run tests, launch Unity, or enter play mode. After edits, only compare the code with the request. The user checks the result in the editor. Do not use git in this project.'
    : 'Edit existing files with edit_file (exact old_string -> new_string); use write_file only for new files or full rewrites; use run_command only for tests/build/git. Never edit files through python/node/powershell scripts in run_command.') + winShellEn;
  const shellUseZh = (unityProject
    ? '这是 Unity 工程。禁止跑测试、禁止启动 Unity、禁止进播放模式。改完只核对代码和需求是否一致，运行效果由用户在编辑器里看。这个工程不能用 git。改已有文件用 edit_file'
    : '改已有文件用 edit_file（old_string 原样替换成 new_string），新建或整份重写才用 write_file；run_command 只用来跑测试/构建/git（命令沙盒：只能在项目目录内，拦截高危命令，有超时），禁止用 python/node/powershell 脚本改文件') + winShellZh;
  const planLine = (!agiOn && hasPlanning)
    ? (enPrompt
      ? `\nThe user talks to you first. The planning module must not read the request before you do. Before the user says start, do not call call_worker. Restate the goal, scope, constraints, and acceptance, and ask the user to reply 开始. After the user says start, call call_worker with role "code" immediately. Do not insert planning in front of that. If you already called planning, use it only to direct code. Do not reply to the user with an unfinished plan.\n`
      : `\n用户只和你说话，规划模块不能先读需求。用户还没说开始时，禁止调用 call_worker。必须先向用户复述目标、范围、约束、验收，结尾写：确认无误后回复「开始」，我再动手。用户已经说了开始之后，立刻调用 call_worker，role 填 code，不要先插规划。若已经派过规划，规划结果只用来指挥代码，不符合就改清再派，禁止把没做完的方案回复给用户。\n`)
    : '';
  const actRuleEn = agiOn
    ? 'AGI is on. The user only accepts the result. You finish everything else yourself and do not wait for start. Permissions are high and this turn is unlimited. Call screen_read first, then do the files, commands, and desktop actions yourself. Open apps and web pages with the keyboard and mouse only. Do not use run_command to run start, Start-Process, or chrome.exe. Do not call call_worker. When finished, tell the user what to check.'
    : 'If the user has not said start this turn, a restatement that asks them to reply 开始 is a complete reply. Do not emit a tool call just to start work. After the user says start, or when the turn is only a lookup, a reply that needs a lookup or an edit must include a tool call. A plan with no tool call does not run. A one-line note may sit in the same reply as the tool call.';
  const actRuleZh = agiOn
    ? 'AGI 开着时，用户只管验收，其他事情你全部自己做完，不要等「开始」，不要复述完就停。权限很高，这一轮全解放。必须先调用 screen_read，然后自己改文件、跑命令、操作键鼠。打开软件和网页只用键鼠，禁止 run_command 去 start、Start-Process 或启动 chrome.exe。禁止 call_worker。做完只告诉用户验收什么。'
    : '用户还没说开始时，禁止派代码。提问、讲现象、报 bug 由大脑自己查完再回答。要改文件但还没说开始时，复述并请用户回复「开始」就是完整回复。用户已经说了开始之后，派代码必须调用 call_worker。可以在同一次回复里附一句说明，但不能只有说明。';
  // [铆钉优化] 能调用工具的模型由大脑自己调用 generate_media 生图；zbaing 本地引擎不会调用工具，仍按开口前自动生成的结果回答。其他 AI 请勿改回「无需调用工具」
  const genFailNote = enPrompt
    ? ' A local image model is stored by filename and resolved inside the models folder; do not ask the user to paste an absolute path. A 401 inside 【生图失败】 is a HuggingFace/engine download failure for companion files, not the chat API and not a missing file path. Repeat the failure text as-is. Do not search the workspace for Bearer tokens.'
    : '生图槽里写文件名即可，程序会在模型目录里找到文件，禁止要求用户改成绝对路径。【生图失败】里的 401 是下载生图引擎或配套文件时 HuggingFace/GitHub 拒绝访问，不是聊天接口，也不是模型路径填错。请原样转述失败原文，禁止去项目里搜 Bearer。';
  const genNote = zbaingBridge
    ? (enPrompt
      ? `\nWhen the user asks to generate images/videos/3D/docs, SimpleCode runs that automatically BEFORE you reply. Check the user message for "生图已完成" or 【生图失败】/【生图未配置】 and answer from those results. Do not say you lack an image-generation tool.${genFailNote}\n`
      : `\n用户要求生图/生视频/生3D/生文档时，SimpleCode 会在你回复前自动执行。请看用户消息里是否已有「生图已完成」或【生图失败】/【生图未配置】等段落并据此回答，禁止说自己没有生图工具。${genFailNote}\n`)
    : (enPrompt
      ? `\nTo generate images/videos/3D/docs, call generate_media yourself (kind + a full prompt you write from the conversation). It uses the generation model in the model combo. It does not need the user to say start, and must not be handed to the code worker or run through run_command / sd-cli. One call per image. After it returns, tell the user the file path. Never say you have no image tool.${genFailNote}\n`
      : `\n要生图/生视频/生3D/生文档时，你自己调用 generate_media：kind 填类型，prompt 写你按对话整理好的完整描述（主体、风格、构图、颜色）。它用「模型组合」里挂的生成模型，不需要用户说「开始」，禁止派给代码模块、禁止用 run_command 去跑 sd-cli。要几张就调用几次。返回后把文件路径告诉用户。禁止说自己没有生图工具。${genFailNote}\n`);
  if (enPrompt) {
    return `${langLine}${personaSection}${zbaingSection}${visionSection}${genNote}${memoryBlock}${askHint}
Workspace: ${workspace || '(none)'}
You may read absolute paths on this machine (not limited to the workspace). list_dir / read_file / search_text / map_lookup / semantic_search accept absolute paths. Do not read other AI skills or rules: .cursor, .claude, AGENTS.md, CLAUDE.md, GEMINI.md, or any SKILL.md outside this app's skills folder and the project's .simple/skills (legacy .sinpo/skills). Follow only the selected skill below.
Relevant modules may already appear under "项目地图" in the user message. Use goto_definition for a known symbol name, semantic_search when you only know the intent, map_lookup for the module method list, and search_text for an exact string. After write_file, a 【类型检查】 block is real compiler output for that file; fix those errors before finishing.
You may write and delete files and create folders (create_dir) in the workspace, user-added extra folders, and skill/rule folders. An existing file you already read by absolute path may be written back with write_file. Do not say the environment cannot find a file you already read, and do not ask the user to add that directory to the workspace.
Skill folders:
${appSkills.map((p) => `- ${p}`).join('\n') || '- (none)'}
Installed skills (names only). Follow only the selected skill below. Do not read or follow any other AI's skills or rules.
${catalog || '- (none)'}
Writes and deletes in the workspace are snapshotted and can be restored. run_command also tracks file changes made by scripts (pre-backup before run, diff after) so they appear in the changed-files list and can be restored.
Use memory_add for durable project conventions; working_memory_update for this-chat notes; ask_user to clarify.
Shell via run_command runs in a sandbox (cwd inside the project, dangerous commands blocked, timeout). ${shellUseEn} Do not run encoding probes (no enc_*.txt); write_file is UTF-8. The project map is a summary so you can skip irrelevant code. When the description and key values are clear and enough, use them and do not re-read the whole file. If you do not understand what the summary is for, or it lacks the copy, numbers, or fields you need, read_file the original source and do not guess. A method name and line number are not a summary. If 【全文】 is already in the message, use that text and do not read the file again. The modules in the message are only the first batch. If they do not match, keep looking with map_lookup and search_text. When the desktop hand is on, the latest message ends with 【屏幕文字】: the foreground window, other windows, saved experience notes for the target app, a control list with ids like [c12] (Windows UI Automation), and OCR text lines with their center @(x,y). Prefer ui_act with a control id (click/toggle/select/expand/set_text); fall back to mouse_click with @(x,y) only when the target has no control id. Follow the saved experience notes. Open apps and web pages with the keyboard and mouse (for example keyboard_key Win+R, then keyboard_type the address). Do not use run_command to run start, Start-Process, or chrome.exe. After a task succeeds, or when you find a non-obvious path or pitfall, call agi_note with one reusable sentence (no passwords or private content). Risky actions (delete, send, pay, Shift+Delete, Enter in chat apps) automatically ask the user first; do not ask again yourself and never work around a refusal. Work in an observe-act-verify loop: one action at a time, then read the 【操作后】 part of the tool result to check it worked before the next step; if nothing changed, rethink instead of repeating the same click. Before keyboard_type or keyboard_key, make sure the target window has focus (window_focus or click its input box). Use screen_read (optionally with wait_ms) to re-read after loading; screen_look only when text is not enough to judge icons or layout. Draw strokes and circles with mouse_drag. Desktop tools only exist while the switch is on; never claim you can see or click the screen otherwise.
Independent read_file / list_dir / search_text / map_lookup / memory_list in the same round should be emitted together as multiple tool calls. write_file calls for different files in the same round also run together. The same file, deletes, create_dir, run_command, memory writes and ask_user stay serial.
${actRuleEn}
Do not invent unread file contents. Copy, numbers, and fields that are not in the map summary or the file body must be read before you write them. Do not guess. After edits, list the files you changed.
Source files must be UTF-8. Never produce mojibake.

## Rules
${ruleText || 'None'}
${skillText}${handoff}${planLine}${houseStyle.promptBlock(enPrompt)}${brainPressure.promptBlock(workspace, enPrompt, agiOn)}`;
  }
  return `${langLine}${personaSection}${zbaingSection}${visionSection}${genNote}${memoryBlock}${askHint}
当前工作目录：${workspace || '（未选择）'}
你可以读取本机绝对路径（不限于当前工作目录）。list_dir / read_file / search_text / map_lookup / semantic_search 都支持绝对路径。禁止读取其他 AI 的技能和规则：.cursor、.claude、AGENTS.md、CLAUDE.md、GEMINI.md，以及不在本程序 skills 目录、项目 .simple/skills（旧目录 .sinpo/skills）里的 SKILL.md。只遵守下面选中的技能。
已知符号名用 goto_definition 跳到定义。只知道意图、不知道名字时用 semantic_search。模块方法列表用 map_lookup。精确字符串用 search_text。write_file 返回里的【类型检查】是该文件的编译错误，改到通过再收尾。
写入、删除和新建文件夹只允许工作目录、用户添加的附加目录、以及技能/规则目录。已经 read_file 读到的绝对路径，用 write_file 写回那个已存在的文件。禁止说执行环境找不到已经读到的文件，禁止要求用户把目录加进工作区。新建空文件夹用 create_dir（可一次建多层）。
技能目录：
${appSkills.map((p) => `- ${p}`).join('\n') || '- （无）'}
已安装技能（只列名字）。只遵守下面选中的技能。不要读取、不要遵守其他 AI 的技能和规则。
${catalog || '- （还没有技能）'}
写入或删除工作目录文件会自动快照，用户可还原。run_command 执行的脚本若改动了工作区文件，也会记入快照和「已更改文件」，可一并还原。
项目长期约定用 memory_add；本会话要点用 working_memory_update；含糊时用 ask_user。
${shellUseZh}；不要写 tmp_*.ps1 批量替换。不要先做编码探针（不要写 enc_*.txt 试编码），write_file 一律 UTF-8。项目地图是提前总结，用来跳过无关代码。作用和关键值看得懂、又够用时，靠总结来改，不必整文件重读。看不懂这句归纳有什么用，或者里面没有要改的文案、数字、字段时，必须 read_file 读原本代码，不准猜。只有方法名和行号不是总结。消息里已有【全文】的，以全文为准，不要再读一遍。消息里的模块只是第一批，对不上就用 map_lookup、search_text 继续查。用户打开「AGI」后，最后一条消息末尾有【屏幕文字】：前台窗口、其他窗口、这个软件以前记下的操作经验、带编号的控件列表（如 [c12]，来自 Windows UI 自动化）、以及 OCR 文字和中心坐标 @(x,y)。有控件编号时优先用 ui_act 按编号操作（click / toggle / select / expand / set_text），目标没有控件编号时才用 mouse_click 点 @(x,y)。照着以前记下的经验做。打开软件、打开网页用键鼠完成（例如 keyboard_key 按 Win+R，再 keyboard_type 输入地址），禁止用 run_command 执行 start、Start-Process 或启动 chrome.exe。任务做成后、或发现不明显的路径和坑时，调用 agi_note 记一句可复用的经验（不记密码、聊天内容等隐私）。删除、发送、付款、Shift+Delete、在聊天软件里按回车这类危险操作，程序会自动先问用户，你不要再自己问一遍；用户不允许就停，禁止换办法绕过去。按「看→做一步→核对」循环：一次只做一个动作，看工具结果里的【操作后】确认生效再做下一步；画面没变就换思路，不要原样重复点。keyboard_type / keyboard_key 之前先确认焦点在目标窗口（window_focus 或点一下输入框）。等界面加载用 screen_read（可带 wait_ms）重读；只有文字判断不了图标、布局时才用 screen_look。画线、画圆用 mouse_drag。开关关着时没有这些工具，不要假装能看见或能点击。
同一轮里互不依赖的 read_file / list_dir / search_text / map_lookup / memory_list 请一次发出多条 tool call，不要拆成多轮。不同文件的 write_file 也可以同一轮一起发，程序会同时写。同一个文件、删除、建目录、命令、记忆写入和 ask_user 必须等结果后再做。
${actRuleZh}
不要编造未读过的文件内容。地图里没有的文案、数字、字段，必须先读到再写，不准猜。改完后用短列表说明改了哪些文件。
代码与注释编码必须是 UTF-8，禁止乱码。

## 规则
${ruleText || '无额外规则'}
${skillText}${handoff}${planLine}${houseStyle.promptBlock(enPrompt)}${brainPressure.promptBlock(workspace, enPrompt, agiOn)}`;
}

const MAX_VISION_IMAGES = 16;
// 一次视觉代理最多识别几张图，避免串行识别过慢
const MAX_VISION_AGENT_IMAGES = 4;
// 单张图片视觉识别超时：本地服务加载模型/处理大图可能较慢，但不能无限等待
const VISION_TIMEOUT_MS = 120 * 1000;

function pushVision(parts, dataUrl) {
  if (!dataUrl) return false;
  const n = parts.filter((p) => p.type === 'image_url').length;
  if (n >= MAX_VISION_IMAGES) return false;
  parts.push({ type: 'image_url', image_url: { url: dataUrl } });
  return true;
}

async function attachmentsToParts(attachments, { vision, signal, noVisionHint, skipImageNote } = {}) {
  const parts = [];
  const extraTexts = [];
  const hint = noVisionHint || '当前模型不支持看图。';
  const skippedImages = [];
  for (const att of attachments || []) {
    const parsed = await parseAttachment(att.path, { signal });
    extraTexts.push(`附件「${parsed.name}」类型：${parsed.kind}`);
    if (parsed.text) extraTexts.push(`----- ${parsed.name} -----\n${parsed.text}`);
    if (parsed.dataUrl) {
      if (vision) pushVision(parts, parsed.dataUrl);
      else {
        skippedImages.push(parsed.dataUrl);
        if (!skipImageNote) extraTexts.push(`用户附上了图片「${parsed.name}」，但你只能看到文件名。${hint}`);
      }
    }
    if (parsed.images?.length) {
      if (vision) {
        let sent = 0;
        for (const img of parsed.images) {
          if (pushVision(parts, img.dataUrl)) sent++;
        }
        extraTexts.push(`${parsed.kind === 'video' ? '视频' : '文档'}「${parsed.name}」已附上 ${sent} 张图。`);
      } else {
        for (const img of parsed.images) skippedImages.push(img.dataUrl);
        if (!skipImageNote) extraTexts.push(`${parsed.kind === 'video' ? '视频' : '文档'}「${parsed.name}」含 ${parsed.images.length} 张图，但你看不到画面。${hint}`);
      }
    }
  }
  return { parts, extraTexts, skippedImages };
}

function modelSupportsVision(modelCfg) {
  // 本地 GGUF 主模型走的是内置引擎的文本通道，不直接接收图片；
  // 主模型不支持看图时，由「模型组合」里的看图槽位负责识别图片。
  if (isLocalGguf(modelCfg)) return false;
  // 用户在「视觉设置」里明确指定过开关时，以开关为准
  if (typeof modelCfg?.vision === 'boolean') return modelCfg.vision;
  const id = `${modelCfg?.model || ''} ${modelCfg?.name || ''}`.toLowerCase();
  return /vl|vision|llava|pixtral|moondream|minicpm-v|gpt-4o|gpt-4\.1|claude|gemini|qwen2\.5-vl|qwen3-vl/.test(id);
}

function noVisionHint(modelCfg) {
  return isLocalGguf(modelCfg)
    ? '本地模型走内置引擎的文本通道，不支持直接看图。要识别画面，请在「文件 → 模型组合」中给当前主模型挂上看图模型。'
    : '要识别画面请换成视觉模型（如 gpt-4o、qwen2.5-vl），或在「模型组合」中挂上看图模型。';
}

/** 本地引擎没把像素喂进去时，模型会用这类套话冒充「识别结果」 */
function isBlindVisionText(text) {
  const s = String(text || '').trim();
  if (!s) return true;
  if (s.length > 800) return false;
  return /无法直接访问或识别图片|无法提取文字或分析画面|看不到(这张)?图|没有看到(任何)?(图片|画面)|cannot directly access or recognize|can'?t see (the )?image|do not (actually )?see (any )?(the )?image|no image (was |is )?provided|没有收到图片|未提供图片|没有看到图片/i.test(s);
}

async function callVisionEndpoint({ endpoint, model, dataUrl, signal, onWait, lang, apiKey, protocol }) {
  const url = `${String(endpoint).replace(/\/$/, '')}/chat/completions`;
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, VISION_TIMEOUT_MS);
  const onAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  onWait?.('正在请求本地看图端点…');
  try {
    const res = await httpFetch(url, { // 走系统代理，与聊天主链路一致
      method: 'POST',
      headers: (() => {
        const h = { 'Content-Type': 'application/json' };
        // 看图端点（API 模型的视觉能力）需要鉴权：openai 系带 Bearer，anthropic/gemini 用各自的 key 头
        if (apiKey) {
          const p = String(protocol || 'openai').toLowerCase();
          if (p === 'anthropic') h['x-api-key'] = apiKey;
          else if (p === 'gemini') h['x-goog-api-key'] = apiKey;
          else h['Authorization'] = 'Bearer ' + apiKey;
        }
        return h;
      })(),
      body: JSON.stringify({
        model: String(model || '').replace(/\.gguf$/i, '') || model || '',
        stream: false,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: replyLang.visionAsk(lang || replyLang.fromLocale(store.load().locale)) },
              { type: 'image_url', image_url: { url: dataUrl } }
            ]
          }
        ]
      }),
      signal: ctl.signal
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`看图端点请求失败 ${res.status}：${t.slice(0, 300)}`);
    }
    const data = await res.json();
    const text = asText(data.choices?.[0]?.message?.content);
    if (!text) throw new Error('看图端点返回了空内容');
    return text;
  } catch (e) {
    if (timedOut) {
      const err = new Error(`看图端点超时（${VISION_TIMEOUT_MS / 1000} 秒）。请确认该地址已加载看图模型，或把端点留空改用内置看图引擎。`);
      err.code = 'vision_timeout';
      throw err;
    }
    if (e.name === 'AbortError') {
      const stopped = !!(signal && signal.aborted);
      const err = new Error(stopped ? '已停止' : '看图端点请求中断');
      err.name = 'AbortError';
      err.code = stopped ? 'aborted' : 'vision_timeout';
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// 看图：本地 GGUF + mmproj 走内置 llama-server（自动下载）；端点仅作可选兜底。
async function visionRecognize({ model, mmproj: mmprojPath, endpoint, dataUrl, signal, onWait, lang, apiKey, protocol }) {
  const vs = store.load();
  const dir = vs.modelsDir || store.defaultModelsDir();
  const file = localLlm.resolveGgufPath({ model, modelPath: '' }, dir);
  const say = (info) => onWait?.(info);
  const ep = endpoint && /^https?:\/\//i.test(endpoint) ? endpoint : '';
  let lastErr = null;

  if (file) {
    let projector = mmprojPath;
    try {
      projector = await mmproj.ensure(file, mmprojPath, say);
    } catch (e) {
      diag.log('vision', '自动准备投影文件失败', { message: e && e.message });
      projector = '';
    }
    if (projector) {
      try {
        const text = await visionEngine.describe({
          modelPath: file,
          mmproj: projector,
          model,
          dataUrl,
          signal,
          onWait: say,
          lang
        });
        if (!isBlindVisionText(text)) {
          diag.log('vision', '内置看图引擎识别成功', { 字符: text.length });
          return text;
        }
        lastErr = new Error('内置看图引擎没有真正看到画面');
        diag.log('vision', '内置看图引擎未看到画面', { preview: String(text).slice(0, 160) });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        lastErr = e;
        diag.log('vision', '内置看图引擎失败', { message: e && e.message });
      }
    } else {
      lastErr = new Error('缺少 mmproj，无法把图片送进看图模型');
    }
  }

  if (ep) {
    try {
      const text = await callVisionEndpoint({ endpoint: ep, model, dataUrl, signal, onWait: say, lang, apiKey, protocol });
      if (!isBlindVisionText(text)) {
        diag.log('vision', '看图端点识别成功', { endpoint: ep, 字符: text.length });
        return text;
      }
      lastErr = lastErr || new Error('看图端点没有真正看到画面');
      diag.log('vision', '看图端点未看到画面', { preview: String(text).slice(0, 160) });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastErr = lastErr || e;
      diag.log('vision', '看图端点失败', { message: e && e.message });
    }
  }

  const err = new Error(
    lastErr?.message
      ? `看图失败：${lastErr.message}`
      : `本地视觉模型「${model || '未配置'}」无法识别图片。请在「模型组合」挂上支持视觉的 GGUF 和 mmproj。`
  );
  err.code = 'vision_unsupported';
  throw err;
}

function visionWait(onEvent) {
  return (info) => {
    const text = typeof info === 'number' ? `视觉识别中 · ${info} 秒` : String(info || '正在识别图片…');
    onEvent?.({ type: 'status', text });
  };
}

async function describeImageFile(abs, { signal, onEvent, lang }) {
  const parsed = await parseAttachment(abs, { signal });
  const dataUrl = parsed.dataUrl || parsed.images?.[0]?.dataUrl;
  if (!dataUrl) return `图片「${path.basename(abs)}」无法读取为图像数据。`;
  const vis = assembly.visionFrom(store.load());
  if (!vis.model) {
    return `图片「${path.basename(abs)}」已找到，但当前没有可用的看图模型。请在「文件 → 模型组合」里挂上看图模型。`;
  }
  onEvent?.({ type: 'status', text: `正在用看图模型识别 ${path.basename(abs)}…` });
  const text = await visionRecognize({
    model: vis.model,
    mmproj: vis.mmproj,
    endpoint: vis.endpoint,
    dataUrl,
    signal,
    onWait: visionWait(onEvent),
    lang: lang || replyLang.fromLocale(store.load().locale),
    apiKey: vis.apiKey,
    protocol: vis.protocol
  });
  if (isBlindVisionText(text)) {
    diag.log('vision', '看图模型未真正看到画面', { file: path.basename(abs), preview: text.slice(0, 160) });
    return `图片「${path.basename(abs)}」本地看图未看到画面。请确认看图槽位挂的是带 mmproj 的视觉 GGUF。`;
  }
  return `【图片识别结果：${path.basename(abs)}】\n${text}`;
}

// 用户在提问卡片里的回答：可能是纯文字，也可能是 { text, images: [dataUrl] }
function answerParts(raw) {
  if (raw && typeof raw === 'object') {
    const images = (Array.isArray(raw.images) ? raw.images : [])
      .filter((u) => typeof u === 'string' && /^data:image\//.test(u))
      .slice(0, 6);
    return { text: String(raw.text || '').trim(), images };
  }
  return { text: String(raw ?? '').trim(), images: [] };
}

/**
 * [铆钉优化] 用户在回答框里贴的截图：挂了看图模型就先识别成文字；主模型自己能看图就把原图留给它。其他 AI 请勿删
 * @returns {Promise<{ text: string, parts: object[] }>} text 拼进工具结果，parts 是要追加给主模型的原图
 */
async function answerImagesForModel(images, { modelCfg, signal, onEvent, lang }) {
  if (!images.length) return { text: '', parts: [] };
  const vis = assembly.visionFrom(store.load());
  if (vis.model) {
    const out = [];
    for (let i = 0; i < images.length; i++) {
      onEvent?.({ type: 'status', text: `正在识别你发的第 ${i + 1}/${images.length} 张截图…` });
      try {
        const text = await visionRecognize({
          model: vis.model,
          mmproj: vis.mmproj,
          endpoint: vis.endpoint,
          dataUrl: images[i],
          signal,
          onWait: visionWait(onEvent),
          lang: lang || replyLang.fromLocale(store.load().locale),
          apiKey: vis.apiKey,
          protocol: vis.protocol
        });
        out.push(isBlindVisionText(text)
          ? `【用户截图 ${i + 1}】看图模型没有看到画面。`
          : `【用户截图 ${i + 1} 识别结果】\n${text}`);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        out.push(`【用户截图 ${i + 1}】识别失败：${e.message}`);
      }
    }
    return { text: out.join('\n\n'), parts: [] };
  }
  if (modelSupportsVision(modelCfg)) {
    return {
      text: `用户还发了 ${images.length} 张截图，原图附在下一条消息里，请直接看图。`,
      parts: images.map((url) => ({ type: 'image_url', image_url: { url } }))
    };
  }
  return { text: `用户发了 ${images.length} 张截图，但当前没有看图模型，看不到画面。请用户在「文件→模型组合」挂看图模型，或把关键内容用文字发给你。`, parts: [] };
}

function flattenMessages(messages) {
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const text = m.content.map((p) => {
      if (typeof p === 'string') return p;
      if (p?.type === 'text') return p.text || '';
      if (p?.type === 'image_url') return '[图片附件]';
      return '';
    }).filter(Boolean).join('\n');
    return { ...m, content: text };
  });
}

function asText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((p) => p?.text || p?.content || '').join('');
  return String(value);
}

function extractReason(obj) {
  return asText(obj?.reasoning_content || obj?.reasoning || obj?.thinking || '');
}

function applyToolDelta(toolCalls, deltaCalls) {
  for (const tc of deltaCalls || []) {
    const idx = tc.index ?? toolCalls.length;
    if (!toolCalls[idx]) toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
    if (tc.id) toolCalls[idx].id = tc.id;
    if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
    if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
  }
}

function consumeChunk(json, acc, onDelta, onReason) {
  const choice = json.choices?.[0] || {};
  const delta = choice.delta || {};
  const piece = asText(delta.content);
  if (piece) {
    acc.content += piece;
    onDelta(piece);
  }
  const reason = extractReason(delta);
  if (reason) {
    acc.reason += reason;
    onReason(reason);
  }
  if (delta.tool_calls) applyToolDelta(acc.toolCalls, delta.tool_calls);
  if (!choice.delta && json.message) {
    const full = asText(json.message.content);
    if (full.length > acc.content.length) {
      const extra = full.slice(acc.content.length);
      acc.content = full;
      if (extra) onDelta(extra);
    }
    const nativeReason = extractReason(json.message);
    if (nativeReason.length > acc.reason.length) {
      const extraR = nativeReason.slice(acc.reason.length);
      acc.reason = nativeReason;
      if (extraR) onReason(extraR);
    }
    if (json.message.tool_calls) acc.toolCalls = json.message.tool_calls;
  }
}

function finishMessage(acc) {
  const msg = { role: 'assistant', content: acc.content || '' };
  if (acc.reason) msg.reasoning_content = acc.reason;
  const toolCalls = (acc.toolCalls || []).filter(Boolean);
  if (toolCalls.length) {
    msg.tool_calls = toolCalls;
    msg.tool_calls.forEach((t, i) => {
      if (!t.id) t.id = `call_${i}`;
      t.type = t.type || 'function';
    });
    if (!msg.content) msg.content = null;
  }
  return msg;
}

function zbaingWantsExplore(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return /(读|看|浏览|列出|扫描|了解|分析|打开).{0,16}(项目|工程|工作区|目录|文件夹|代码库|workspace|repo|当前)/i.test(t)
    || /(项目|工程|工作区|目录|代码库).{0,16}(读|看|浏览|列出|扫描|结构|情况)/i.test(t)
    || /读取.{0,12}当前/i.test(t)
    || /当前目录/i.test(t);
}

function zbaingSearchQuery(text) {
  const t = String(text || '').trim();
  const m = t.match(/(?:搜索|查找|search|find)\s+[`'"]?(.+?)[`'"]?\s*$/i);
  return m ? m[1].trim() : '';
}

async function zbaingPreflightTools({ workspace, extra, userText, snap, onEvent, signal, lang }) {
  if (!workspace) return '';
  const blocks = [];
  const toolLabel = { list_dir: '查看目录', read_file: '读取文件', search_text: '搜索代码' };

  if (zbaingWantsExplore(userText)) {
    onEvent({ type: 'tool', name: 'list_dir', status: 'running', detail: workspace, text: toolLabel.list_dir });
    const tree = await execTool(workspace, snap, 'list_dir', {}, onEvent, extra, signal, lang);
    onEvent({ type: 'tool', name: 'list_dir', status: 'done', detail: workspace, text: `完成：${toolLabel.list_dir}` });
    blocks.push(`【工作区目录】\n${tree}`);
    for (const f of ['README.md', 'readme.md', 'package.json', 'config.json']) {
      const abs = path.join(workspace, f);
      if (!fs.existsSync(abs)) continue;
      try {
        onEvent({ type: 'tool', name: 'read_file', status: 'running', detail: f, text: `${toolLabel.read_file} ${f}` });
        const content = await execTool(workspace, snap, 'read_file', { path: f }, onEvent, extra, signal, lang);
        onEvent({ type: 'tool', name: 'read_file', status: 'done', detail: f, text: `完成：${toolLabel.read_file} ${f}` });
        blocks.push(`【${f}】\n${String(content)}`);
      } catch { /* skip unreadable */ }
    }
  }

  const q = zbaingSearchQuery(userText);
  if (q) {
    onEvent({ type: 'tool', name: 'search_text', status: 'running', detail: q, text: `${toolLabel.search_text} ${q}` });
    const hits = await execTool(workspace, snap, 'search_text', { query: q }, onEvent, extra, signal, lang);
    onEvent({ type: 'tool', name: 'search_text', status: 'done', detail: q, text: `完成：${toolLabel.search_text}` });
    blocks.push(`【搜索结果：${q}】\n${hits}`);
  }

  return blocks.length ? blocks.join('\n\n') : '';
}

function sameModel(a, b) {
  if (!a || !b) return false;
  if (isLocalGguf(a) && isLocalGguf(b)) {
    return (a.model || a.modelPath) === (b.model || b.modelPath);
  }
  return !!(a.id && a.id === b.id);
}

function buildRoster(vs, modelCfg) {
  const brainName = modelCfg.model || modelCfg.name || '主模型';
  const models = [{ name: brainName, role: 'brain' }];
  for (const role of assembly.ROLES) {
    const hit = assembly.resolveRole(vs, role.id);
    if (!hit) continue;
    const cfg = assembly.slotToModelCfg(hit.slot, vs);
    if (!cfg) continue;
    const name = cfg.model || cfg.name || role.name;
    if (models.some((m) => m.name === name && m.role === role.id)) continue;
    models.push({ name, role: role.id });
  }
  return models;
}

function codeWorkerOf(vs, modelCfg) {
  const hit = assembly.resolveRole(vs, 'code');
  if (!hit) return null;
  const cfg = assembly.slotToModelCfg(hit.slot, vs);
  if (!cfg) return null;
  // 代码槽即使和大脑是同一只模型，也要单独派工。否则大脑会自己改文件、自己跑命令
  return cfg;
}

function planningWorkerOf(vs, modelCfg) {
  const hit = assembly.resolveRole(vs, 'planning');
  if (!hit) return null;
  const cfg = assembly.slotToModelCfg(hit.slot, vs);
  if (!cfg || sameModel(cfg, modelCfg)) return null;
  return cfg;
}

function planningTaskReady(task) {
  return String(task || '').trim().length >= 40;
}

function workerTaskReady(task) {
  const t = String(task || '').trim();
  if (t.length < 120) return false;
  return /[\\/]|\.[a-z0-9]{1,8}\b/i.test(t);
}

function isLocalGguf(modelCfg) {
  if (!modelCfg) return false;
  if (modelCfg.type === 'local') return true;
  if (modelCfg.modelPath) return true;
  return /\.gguf$/i.test(String(modelCfg.model || ''));
}

function isZbaingAi(modelCfg) {
  return modelCfg?.type === 'zbaingAi' || modelCfg?.id === 'zbaingAi';
}

function isZbaingModule(modelCfg) {
  return modelCfg?.type === 'zbaingModule' && !!modelCfg?.moduleId;
}

function isEmptyZbaingReply(msg) {
  const t = asText(msg?.content).trim();
  if (!t) return true;
  return /zbaingAi 没有返回内容|没有生成到文字/.test(t);
}

function pickTextFallbackCfg(exceptId) {
  const s = store.load();
  const usable = [];
  for (const m of s.models || []) {
    if (!m || m.id === exceptId) continue;
    if (m.type === 'zbaingAi' || m.type === 'zbaingModule' || m.id === 'zbaingAi') continue;
    const cfg = store.resolveModelCfg(m.id, s);
    if (!cfg) continue;
    if (cfg.type === 'local' && (cfg.modelPath || cfg.model)) usable.push(cfg);
    else if (cfg.baseUrl && cfg.model) usable.push(cfg);
  }
  return usable.find((c) => c.type !== 'local') || usable[0] || null;
}

function latestUserOrder(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    const t = asText(m.content).trim();
    if (!t) continue;
    if (/规划轮次已用完|大脑轮次已用完|请立刻调用 call_worker|还没有派工|用户本轮已经说了开始|用户本轮没有说开始|需求已经由你接收/.test(t)) continue;
    return t;
  }
  return '';
}

/** 本轮用户消息是开工令。问「为什么还没开始」不算。 */
// [铆钉优化] 原规则只认「开始 / 开始吧」等极少说法，「开始改」「开工」「直接改」「我说了开始为什么还不改」
// 全被判成没开始，导致大脑一直分析不派单。这里放宽成常见开工说法，并排除否定句。其他 AI 请勿收紧回去
function userOrderedStart(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  // 否定 / 暂缓：先不开始、别改、等等
  if (/(先|暂时|暂且)?(不要|别|不用|先别|暂不|不准|禁止)(开始|开工|动手|改|修|写)|等(一下|等|会)再|先不(开始|改|动)/.test(t)) return false;
  // 用户在催：我说了开始、让你开始、怎么还不改
  if (/(说了|说过|已经说|让你|叫你|都说)(了)?[「『"]?开始|怎么还(不|没)(开工|动手|改|修|开始)|还(不|没)(开工|动手|改|开始)|快(点)?(改|开工|动手)/.test(t)) return true;
  if (/为什么|为何|无法开始|不能开始/.test(t)) return false;
  if (/^(开始|可以开始|动手|干吧|开始吧|直接开始|开始做|开始干活|开工|开干|start|go|do it|结合你的复述开始)[!！。.\s~～]*$/i.test(t)) return true;
  // 开始 / 开工 / 动手 后面紧跟动作词
  if (/(开始|开工|动手)(改|修|写|做|干|弄|实现|加|打印|处理|执行|吧|啊|呀|咯|了)/.test(t) && !/[?？]\s*$/.test(t)) return true;
  if (/(直接开始|可以开始|开始做|开始吧|动手吧|干吧|结合你的复述开始|开始干活|直接改|直接修|直接动手|去改吧|改吧|修吧|就这么改|按(这个|你的|此)?方案(改|做|来))/.test(t) && !/[?？]\s*$/.test(t)) return true;
  return /(^|[\s，,。；;！!])开始([，,。！!\s~～]|$)/.test(t) && t.length <= 120 && !/[?？]\s*$/.test(t);
}

/** 上一条助手消息在等「开始」，用户只回了肯定词（好 / 可以 / 行 / 就这样），也算开工。 */
function startOrderedFor(text, history) {
  if (userOrderedStart(text)) return true;
  const t = String(text || '').trim();
  if (!t || t.length > 30) return false;
  if (!/^(好|好的|好滴|行|可以|可|嗯|嗯嗯|对|是|是的|确认|没问题|同意|ok|okay|yes|y|就这样|就这么办|照做|没错)[!！。.\s~～]*$/i.test(t)) return false;
  for (let i = (history || []).length - 1; i >= 0; i--) {
    const m = history[i];
    if (!m || m.role !== 'assistant') continue;
    return /确认无误后回复|回复[「『"]?开始|reply "?start/i.test(asText(m.content != null ? m.content : m.text));
  }
  return false;
}

/** 提问、讲现象、报 bug：只由大脑查和答，不必等「开始」，也不派代码。 */
function userAskedQuestion(text) {
  const t = String(text || '').trim();
  if (!t || userOrderedStart(t)) return false;
  if (/[?？]|为什么|为何|怎么|如何|是什么|什么是|咋回事|为啥/.test(t)) return true;
  if (/改|修|实现|加上|写上|写代码|帮我|动手|干吧|重构/.test(t)) return false;
  return /没有|没触发|不触发|直接(让我|打开|进)|没出现|不出现|出问题|有问题|不对|\bbug\b/i.test(t);
}

/** 选项按钮的答案是否等于「开始」，比如「开始」「确认，开始修改」「按这个方案来」。 */
function askAnswerIsStart(answer) {
  const t = String(answer || '').trim();
  if (!t) return false;
  if (/不|别|先不|暂不|取消|等等|再想|不要/.test(t)) return false;
  if (userOrderedStart(t)) return true;
  return /^(确认|好的?|可以|是的?|没问题|同意|ok|yes)?[，,。\s]*(开始|动手|开工|执行|就这么办|照做|按(这个|此|该)?方案|start|go|do it)/i.test(t);
}

const START_WORK_NUDGE = '用户本轮已经说了开始。这是强制开工。禁止复述、禁止讨论、禁止再搜索。立刻调用 call_worker，role 填 code。task 用已经掌握的文件路径、方法、行号、现状、目标、不要改的范围写全。';
const AGI_SELF_NUDGE = 'AGI 开着。用户只管验收，不要等「开始」，不要只写说明。先看过屏幕之后，自己调用 edit_file、write_file、run_command、ui_act 或键鼠把事情做完。禁止 call_worker。';
const AGI_MUST_LOOK = 'AGI 开着。用户只管验收。本轮必须先调用 screen_read，不能跳过，禁止说不会用 AGI。看完就自己把改文件、命令和键鼠做完，不要等「开始」，禁止派单。';
const AGI_FILL = '用户只管验收，其他事情你自己做完。需求没说全就补全，然后直接改文件、跑命令或操作键鼠。禁止说不会，禁止把缺口交回用户，禁止等「开始」，禁止复述完就停。';
const WAIT_START_NUDGE = '用户本轮没有说开始。禁止派代码，禁止改文件，禁止再调用 call_worker。用几句话复述目标、范围、约束、验收，结尾必须写：确认无误后回复「开始」，我再动手。然后停住。';

/** 用户已经说了开始之后，回复里不许再向他要一次开始。 */
function stripStartAsk(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((line) => !/确认无误后回复|请回复.{0,8}开始|回复[「『""]开始|我再动手/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
// [铆钉优化] 没说开始时大脑常误报「没有可用的文件写入工具」。把这类句子删掉，
// 改成请用户回复开始，避免用户以为程序坏了。其他 AI 请勿删除
const NO_WRITE_TOOL_RE = /(没有|无|缺少|缺乏|不具备)(可用的?|任何)?[^。\n]{0,8}(文件)?(写入|写文件|改文件|编辑|修改)[^。\n]{0,4}(工具|权限|能力)|(无法|不能|没法)(直接)?(写入|改动|修改|编辑)(文件|代码)|写入工具(不可用|不存在)|no (file[- ]?)?(write|edit)(ing)? tool|(cannot|can't|unable to) (write|edit) files?/i;
function fixNoWriteToolClaim(text, en) {
  const src = String(text || '');
  if (!NO_WRITE_TOOL_RE.test(src)) return src;
  const cleaned = src
    .split(/(?<=[。！？!?\n])/)
    .filter((s) => !NO_WRITE_TOOL_RE.test(s))
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const ask = en ? 'Reply "start" once confirmed and I will do it.' : '确认无误后回复「开始」，我再动手。';
  return /确认无误后回复|reply "start"/i.test(cleaned) ? cleaned : [cleaned, ask].filter(Boolean).join('\n\n');
}

const KEEP_DISPATCH_NUDGE = '文件还没按需求写入。禁止向用户解释失败、禁止道歉、禁止交回问题。用你已经读到的绝对路径和内容，把要改成的具体文字写进 task，立刻再调用 call_worker，role 填 code。部下说找不到、不会、停止，都由你补全后再派。';

function filesLanded(snap) {
  if (snap && snap.wroteFiles > 0) return true;
  const changes = snap && snap.current && snap.current.manifest && snap.current.manifest.changes;
  return Array.isArray(changes) && changes.length > 0;
}

/** Luna 听到「先说明再调用」会只写计划并停。本轮还没执行过工具时强制 tool_choice。 */
function lunaMustTool(modelCfg, messages, roleTag, implementing, orderedStart) {
  const name = `${modelCfg?.model || ''} ${modelCfg?.name || ''}`;
  if (!/luna/i.test(name)) return false;
  if (!orderedStart) return false;
  if (implementing || (roleTag || 'brain') !== 'brain') return false;
  return !(messages || []).some((m) => m && m.role === 'tool');
}

function announcesWork(text) {
  const s = String(text || '');
  if (/已完成|已经改好|验收通过/.test(s)) return false;
  return /我(现在|先|会|来|要).{0,40}(查|定位|读|搜|派|改|看|找|核对|汇总|调用)/.test(s);
}

/** 还在许诺下一步，不是交给用户的结果。 */
function stillWorking(text) {
  const s = String(text || '');
  if (/已完成|已经改好|验收通过|不需要再改/.test(s)) return false;
  return announcesWork(s) || /我正在|正在(修正|改|查|算|跑|提取)|再给你|接下来我|还没(做完|改完|跑完)|尚未/.test(s);
}

async function completeOnce({ modelCfg, messages, workspace, stream, onDelta, onReason, onThink, signal, useTools = true, onWait, toolSpec, toolChoice }) {
  onDelta = onDelta || (() => {});
  onReason = onReason || (() => {});
  onThink = onThink || (() => {});
  onWait = onWait || (() => {});
  if (isZbaingModule(modelCfg)) {
    const zb = (store.load().models || []).find((m) => m.type === 'zbaingAi' || m.id === 'zbaingAi') || {};
    const msg = await zbaingAi.complete({
      modelCfg: { ...zb, zbaingRoot: modelCfg.zbaingRoot || zb.zbaingRoot },
      messages,
      workspace,
      onDelta,
      onThink,
      onReason,
      signal,
      module: modelCfg.moduleId,
      role: modelCfg._helperRole || ''
    });
    return toolXml.hydrateAssistantTools(msg);
  }
  if (isZbaingAi(modelCfg)) {
    const msg = await zbaingAi.complete({ modelCfg, messages, workspace, onDelta, onThink, onReason, signal });
    return toolXml.hydrateAssistantTools(msg);
  }
  if (isLocalGguf(modelCfg)) {
    return localLlm.complete({
      modelCfg,
      modelsDir: store.load().modelsDir || store.defaultModelsDir(),
      messages,
      onDelta,
      onReason,
      signal,
      onWait,
      tools: useTools ? (toolSpec || toolsSpec()) : null
    }).then((msg) => toolXml.hydrateAssistantTools(msg));
  }
  return apiProtocol.complete({
    modelCfg: {
      ...modelCfg,
      protocol: apiProtocol.normalizeProtocol(modelCfg.protocol)
    },
    messages,
    stream: !!stream,
    tools: useTools ? (toolSpec || toolsSpec()) : null,
    toolChoice: useTools ? (toolChoice || null) : null,
    onDelta,
    onReason,
    signal,
    onWait
  }).then((msg) => toolXml.hydrateAssistantTools(msg));
}

function hasOutput(msg) {
  const named = (msg?.tool_calls || []).some((t) => t?.function?.name);
  return !!(asText(msg?.content).trim() || named);
}

function isUserStop(e, signal) {
  if (signal?.aborted) return true;
  return e?.name === 'AbortError' && (e?.code === 'aborted' || /已停止/.test(String(e?.message || '')));
}

function isRetryableHttpError(e) {
  if (!e || isUserStop(e)) return false;
  if (e.code === 'timeout') return false;
  const status = Number(e.status || e.statusCode || 0);
  if ([408, 409, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  const msg = String(e.message || e.body || e || '');
  return /429|429001|rate exceeds|RPM limit|too many requests|ECONNRESET|socket hang up|fetch failed|network|overloaded|temporar|high demand|503|502|504/i.test(msg);
}

function retryDelayMs(e, attempt) {
  const raw = Number(e?.retryAfter);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.min(60000, raw < 200 ? raw * 1000 : raw);
  }
  return Math.min(20000, 2000 * (2 ** attempt));
}

function abortErr() {
  return Object.assign(new Error('已停止'), { name: 'AbortError', code: 'aborted' });
}

function sleepMs(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortErr());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortErr());
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function waitStatus(onEvent) {
  return (sec) => {
    const text = typeof sec === 'string' ? sec : (sec >= 30 ? `模型已 ${sec} 秒没有响应，仍在等待…` : `正在等待模型响应 · ${sec}`);
    onEvent({ type: 'status', text });
  };
}

function formatToolProgress(messages) {
  const bits = [];
  for (const m of messages || []) {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const names = m.tool_calls.map((t) => t.function?.name).filter(Boolean).join(', ');
      if (names) bits.push(`已调用：${names}`);
    }
    if (m.role === 'tool') {
      const body = asText(m.content);
      const keep = body.includes('【文件】') || body.includes('【全文】');
      bits.push(`【工具结果】\n${keep ? body : body.slice(0, 12000)}`);
    }
  }
  return bits.join('\n\n');
}

async function completeOnceWithRetry(opts, mode) {
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try {
      const msg = await completeOnce({ ...opts, ...mode });
      if (hasOutput(msg)) return msg;
      if (isZbaingAi(opts.modelCfg) || isZbaingModule(opts.modelCfg)) {
        return { ...(msg || {}), role: 'assistant', content: asText(msg?.content) };
      }
      lastErr = new Error('模型返回了空内容，可能模型卡住或未正常生成。请重试或换一个模型。');
      break;
    } catch (e) {
      if (isUserStop(e, opts.signal)) throw e;
      lastErr = e;
      if (e.code === 'no_vision') throw e;
      // [铆钉优化] 模型长时间不响应只自动重试 1 次，再不响应就报错停下，避免反复干等。其他 AI 请勿加大次数
      if (e.code === 'no_response') {
        if (i >= 1) throw e;
        opts.onWait?.(`${e.message}正在自动重试（1/1）…`);
        diag.log('agent', '模型无响应，自动重试一次', { model: opts.modelCfg?.model, message: e.message });
        continue;
      }
      if (!isRetryableHttpError(e) || i >= 3) break;
      const wait = retryDelayMs(e, i);
      const sec = Math.max(1, Math.ceil(wait / 1000));
      opts.onWait?.(`接口繁忙或限流，${sec} 秒后重试（${i + 1}/4）…`);
      diag.log('agent', '请求可重试失败，等待后重试', {
        status: e.status,
        wait,
        attempt: i + 1,
        message: e && e.message
      });
      await sleepMs(wait, opts.signal);
    }
  }
  throw lastErr || new Error('模型没有返回内容');
}

async function completeWithFallback(opts) {
  const noTools = !!opts.noTools;
  if (isZbaingAi(opts.modelCfg) || isZbaingModule(opts.modelCfg)) {
    return completeOnceWithRetry(opts, { stream: true, useTools: false });
  }
  if (isLocalGguf(opts.modelCfg)) {
    let lastErr;
    for (const useTools of (noTools ? [false] : [true, false])) {
      try {
        const msg = await completeOnceWithRetry(opts, { stream: true, useTools });
        if (hasOutput(msg)) return msg;
        lastErr = new Error('模型返回了空内容，可能模型卡住或未正常生成。请重试或换一个模型。');
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        lastErr = e;
        if (/未找到本地 GGUF/.test(String(e.message || ''))) throw e;
      }
    }
    throw lastErr || new Error('模型没有返回内容');
  }
  const tries = noTools
    ? [
      { stream: true, useTools: false },
      { stream: false, useTools: false }
    ]
    : [
      { stream: true, useTools: true },
      { stream: false, useTools: true },
      { stream: true, useTools: false },
      { stream: false, useTools: false }
    ];
  let lastErr;
  for (const mode of tries) {
    try {
      const msg = await completeOnceWithRetry(opts, mode);
      if (hasOutput(msg)) return msg;
      lastErr = new Error('模型返回了空内容，可能模型卡住或未正常生成。请重试或换一个模型。');
    } catch (e) {
      if (isUserStop(e, opts.signal)) throw e;
      lastErr = e;
      if (e.code === 'no_vision' && Array.isArray(opts.messages?.[opts.messages.length - 1]?.content)) {
        diag.log('agent', '接口不接受图片，改为纯文字重试', { model: opts.modelCfg?.model });
        opts = { ...opts, messages: flattenMessages(opts.messages) };
        continue;
      }
      if (e.code === 'no_response') throw e;
      if (isRetryableHttpError(e)) break;
    }
  }
  throw lastErr || new Error('模型没有返回内容');
}

async function agentLoop({ modelCfg, messages, workspace, extra, snap, onEvent, signal, lang, workingMemoryRef, waitForUserAnswer, maxRounds, toolSpec, workers, roleTag, depth, hardRounds, unlimitedRounds, wantPlanning, userOrder, startOrdered }) {
  const thinkLimit = store.clampAgentRounds(maxRounds != null ? maxRounds : DEFAULT_MAX_ROUNDS);
  const toolLabel = {
    list_dir: '查看目录',
    read_file: '读取文件',
    write_file: '写入文件',
    edit_file: '修改文件',
    create_dir: '创建文件夹',
    mkdir: '创建文件夹',
    delete_file: '删除文件',
    search_text: '搜索代码',
    semantic_search: '语义检索',
    map_lookup: '查项目地图',
    goto_definition: '跳转到定义',
    memory_list: '查看记忆',
    memory_add: '写入记忆',
    memory_forget: '删除记忆',
    working_memory_update: '更新工作记忆',
    ask_user: '询问用户',
    brain_pressure: '记压力',
    screen_read: '读屏幕文字',
    screen_look: '看屏幕',
    window_list: '列出窗口',
    window_focus: '切换窗口',
    ui_act: '操作控件',
    agi_note: '记住操作经验',
    clipboard_look: '看剪贴板',
    mouse_move: '移动虚拟光标',
    mouse_click: '点击',
    mouse_drag: '长按拖动',
    mouse_scroll: '滚动',
    keyboard_type: '输入文字',
    keyboard_key: '按键',
    run_command: '沙盒命令',
    generate_media: '生成',
    call_worker: '交给部下'
  };
  let finalText = '';
  let answered = false;
  let softRetry = 0;
  let errorResume = 0;
  const isZbaing = isZbaingAi(modelCfg) || isZbaingModule(modelCfg);
  const seenToolKeys = new Map();
  let thinkUsed = 0;
  let brainUsed = 0;
  // 代码实现不吃思考轮次
  let implementing = (roleTag || 'brain') === 'code';
  let handedOff = false;
  let forceTool = false;
  let forcedDispatch = false;
  let thinkingClosed = false;
  let startNudged = false;
  let waitStartNudged = false;
  let planNudged = 0;
  let planningDone = false;
  let needFacts = false;
  let agiUsed = false;
  let agiForceCount = 0;
  let agiFillCount = 0;
  // 用户原话判断开工。消息里还拼着项目地图、屏幕文字，拿它判断会把「开始」认成没说
  const orderText = userOrder != null ? String(userOrder) : latestUserOrder(messages);
  const brainWithCode = (roleTag || 'brain') === 'brain' && !!(workers && workers.code);
  const agiBrain = desktopOn() && (roleTag || 'brain') === 'brain' && !(depth || 0);
  const orderedByText = startOrdered != null ? !!startOrdered : userOrderedStart(orderText);
  let orderedStart = (brainWithCode || agiBrain) && (orderedByText || !!(snap && snap.askStarted));
  const brainRoles = ['planning', 'code'].filter((r) => workers && workers[r]);
  let activeTools = agiBrain
    ? toolsFor('brain', brainRoles, true)
    : ((brainWithCode && orderedStart) ? toolsFor('brain', brainRoles, true) : toolSpec);
  let lastPhase = roleTag === 'code' ? 'code' : 'brain';
  // 全解放：不吃用户轮数，也不吃安全上限，直到模型收尾或用户停止。AGI 开着时大脑默认全解放
  const unlimited = (!!unlimitedRounds || agiBrain) && !(hardRounds > 0);
  // 用户回答里带的截图原图，等这一轮工具结果都放回对话后再作为一条用户消息追加
  const askImageParts = [];
  const roundCap = hardRounds > 0 ? hardRounds : (unlimited ? Number.POSITIVE_INFINITY : SAFETY_MAX_ROUNDS);
  for (let round = 0; round < roundCap; round++) {
    if (signal?.aborted) throw new Error('已停止');
    const brainName = modelCfg.model || modelCfg.name || '主模型';
    const tag = roleTag || 'brain';
    const mustDispatchNow = !agiBrain && (orderedStart || forcedDispatch) && !handedOff && tag === 'brain' && workers && workers.code;
    if (needFacts && mustDispatchNow) {
      thinkingClosed = true;
      forceTool = 'required';
      needFacts = false;
    } else if (mustDispatchNow) {
      forcedDispatch = true;
      thinkingClosed = true;
      forceTool = { type: 'function', function: { name: 'call_worker' } };
      if (!startNudged) {
        startNudged = true;
        messages.push({ role: 'user', content: orderedStart ? START_WORK_NUDGE : '大脑轮次已用完，已经查到的材料够派工了。请立刻调用 call_worker，role 填 code。task 写清要改的文件路径、相关方法与行号、现状、目标、不要改的范围。不要再搜索，不要只写结论。' });
      }
    }
    // AGI 开着且这轮还没看过屏幕：先强制 screen_read，看屏幕不等「开始」
    if (agiBrain && !agiUsed && !isZbaing && agiForceCount < 3) {
      agiForceCount += 1;
      forceTool = { type: 'function', function: { name: 'screen_read' } };
    }
    // 需求先到大脑。规划只在大脑 call_worker role=planning 时单独调用
    const countAs = tag === 'code' ? 'code' : 'brain';
    lastPhase = countAs;
    const usedNow = countAs === 'code' ? thinkUsed : brainUsed;
    if (!mustDispatchNow && !unlimited && !(hardRounds > 0) && !compact.thinkBudgetOpen({ thinkUsed: usedNow, thinkLimit, implementing })) {
      // 思考轮次用完还没派工：工具调用不占轮次，强制交给实现模型
      const canDispatch = !agiBrain && orderedStart && workers && workers.code && !handedOff && tag === 'brain';
      if (canDispatch) {
        forcedDispatch = true;
        thinkingClosed = true;
        continue;
      }
      break;
    }
    if (!isZbaing) {
      onEvent({
        type: 'think',
        text: round === 0 ? '正在思考...' : (implementing ? '继续改代码...' : '根据工具结果继续思考...')
      });
    }
    onEvent({
      type: 'status',
      text: tag === 'brain'
        ? (implementing
          ? `正在调用 ${brainName}（大脑 · 思考）…`
          : `正在调用 ${brainName}（大脑 · 思考 ${unlimited ? '全解放' : `${brainUsed + 1}/${thinkLimit}`}）…`)
        : (implementing
          ? `正在调用 ${brainName}（代码 · 改代码）…`
          : `正在调用 ${brainName}（代码 · 实现 ${unlimited ? '全解放' : `${thinkUsed + 1}/${thinkLimit}`}）…`),
      activeModel: brainName,
      activeRole: tag
    });
    if ((roleTag || 'brain') === 'brain' && !(depth || 0) && desktopOn()) {
      try {
        const screenText = require('./screen-text-map');
        const frame = await screenText.observe();
        screenText.applyToMessages(messages, screenText.formatBlock(frame));
      } catch (err) {
        diag.log('desktop', '屏幕观察失败', { message: err && err.message });
      }
    }
    const toolChoice = (forceTool && typeof forceTool === 'object')
      ? forceTool
      : ((forceTool || lunaMustTool(modelCfg, messages, roleTag, implementing, orderedStart)) ? 'required' : null);
    diag.log('agent', '请求模型', {
      round,
      model: modelCfg.model,
      消息条数: messages.length,
      阶段: countAs,
      toolChoice: toolChoice || 'auto',
      大脑已用: brainUsed,
      代码已用: thinkUsed,
      思考上限: thinkLimit,
      实现中: implementing
    });
    let msg;
    try {
      msg = await completeWithFallback({
        modelCfg,
        messages,
        workspace,
        onDelta: (t) => onEvent({ type: 'reason', text: t }),
        onReason: (t) => onEvent({ type: 'reason', text: t }),
        onThink: (t) => onEvent({ type: 'think', text: t }),
        onWait: waitStatus(onEvent),
        signal,
        toolSpec: activeTools || toolsSpec(),
        toolChoice
      });
      forceTool = false;
    } catch (e) {
      if (isUserStop(e, signal)) throw e;
      if (compact.isContextOverflowError(e)) {
        e.code = e.code || 'context_overflow';
        throw e;
      }
      const hasProgress = (messages || []).some((m) => m.role === 'tool') || !!finalText;
      diag.log('agent', '本轮模型调用失败，尝试接上', {
        round,
        message: e && e.message,
        hasProgress
      });
      const canResume = (unlimited || round < SAFETY_MAX_ROUNDS - 1) && (unlimited || compact.thinkBudgetOpen({ thinkUsed: usedNow, thinkLimit, implementing }));
      if (hasProgress && canResume && errorResume < 2) {
        errorResume += 1;
        onEvent({ type: 'think', text: `调用出错，正在用已有结果继续：${e.message}` });
        onEvent({ type: 'status', text: '出错了，正在接上…' });
        messages.push({
          role: 'user',
          content: `模型请求失败：${String(e.message || e).slice(0, 500)}\n请根据已经拿到的工具结果继续完成用户任务，不要重复已经成功的步骤。若还需要读文件，直接发起 tool call。`
        });
        continue;
      }
      if (hasProgress) {
        const progress = formatToolProgress(messages);
        const note = `\n\n调用中断：${String(e.message || e).slice(0, 300)}\n已保留上面的工具结果。发送「继续」即可接上。`;
        finalText = [finalText, progress, note].filter(Boolean).join('\n');
        onEvent({ type: 'text', text: note });
        answered = true;
        break;
      }
      throw e;
    }
    diag.log('agent', '模型已返回', { round, 工具调用数: (msg.tool_calls || []).length });
    if (msg.zbaingMeta) {
      onEvent({
        type: 'zbaing_meta',
        source: msg.zbaingMeta.source,
        prompt: msg.zbaingMeta.prompt,
        minConf: msg.zbaingMeta.minConf,
        thinking: msg.zbaingMeta.thinking || ''
      });
    }
    messages.push(msg);
    if (!msg.tool_calls?.length) toolXml.hydrateAssistantTools(msg);
    const calls = (msg.tool_calls || []).filter((t) => t?.function?.name);
    if (calls.length) {
      // 过程稿不要占气泡：后面往往还要跑很多轮，占着会让人以为已经说完、其实还在调模型
      onEvent({ type: 'rewrite_text', text: '' });
      const draft = asText(msg.content).trim();
      if (draft) onEvent({ type: 'reason', text: draft.slice(0, 1500) });
      if (draft.length > 600) msg.content = draft.slice(0, 600) + '…';
    } else if (asText(msg.content).trim()) {
      finalText = orderedStart ? stripStartAsk(asText(msg.content)) : asText(msg.content);
      onEvent({ type: 'rewrite_text', text: finalText });
    }

    if (!calls.length) {
      if (agiBrain && !agiUsed && !isZbaing && agiForceCount < 3 && round < SAFETY_MAX_ROUNDS - 1) {
        forceTool = { type: 'function', function: { name: 'screen_read' } };
        messages.push({ role: 'user', content: AGI_MUST_LOOK });
        onEvent({ type: 'status', text: 'AGI 开着，先看屏幕…' });
        continue;
      }
      const handsBack = /不会用|不会做|做不到|无法(操作|完成|使用)|请你(补充|说明|告诉|决定)|需求不(全|清楚|完整|明确)|你想怎么|我不(知道|清楚|会)|确认无误后回复|请回复.{0,8}开始|我再动手|等你说开始/.test(asText(msg.content));
      if (agiBrain && handsBack && agiFillCount < 2 && round < SAFETY_MAX_ROUNDS - 1) {
        agiFillCount += 1;
        messages.push({ role: 'user', content: AGI_FILL });
        onEvent({ type: 'status', text: 'AGI 自己补全需求…' });
        continue;
      }
      const beforeStart = !agiBrain && !orderedStart && (roleTag || 'brain') === 'brain' && !implementing;
      if (beforeStart && asText(msg.content).trim() && !msg.truncated) {
        const asked = /确认无误后回复|回复.{0,8}开始/.test(asText(msg.content));
        const questionOnly = userAskedQuestion(orderText);
        if (!asked && !questionOnly && !waitStartNudged) {
          waitStartNudged = true;
          messages.push({ role: 'user', content: agiBrain ? AGI_FILL : WAIT_START_NUDGE });
          onEvent({ type: 'status', text: '还没开工，先复述并等你说开始…' });
          continue;
        }
        finalText = asText(msg.content);
        onEvent({ type: 'rewrite_text', text: finalText });
        answered = true;
        break;
      }
      const raw = `${asText(msg.content)}\n${asText(msg.reasoning_content)}`;
      // 只有思考、没有正文也没有工具：先再要一次真正的 tool call，不要把思考当成收工
      const thoughtOnly = !asText(msg.content).trim() && !!asText(msg.reasoning_content).trim();
      const toolsAlready = (messages || []).some((m) => m && m.role === 'tool');
      const working = stillWorking(raw);
      const doneTalk = /已完成|已经改好|验收通过|不需要再改/.test(raw);
      // 还没执行过工具时，正文计划不算收工。说「正在做」时，不论前面有没有工具，都不能收工
      const mustDispatch = !toolsAlready && (roleTag || 'brain') === 'brain' && !implementing && softRetry < 1 && !doneTalk;
      const mustHandOff = !agiBrain && (forcedDispatch || orderedStart) && !handedOff && (roleTag || 'brain') === 'brain' && softRetry < 4;
      const stillOpen = toolsAlready && /尚未落盘|没执行编辑|还没改|没有改完|改动还没/.test(raw);
      const unfinished = !!(mustDispatch || mustHandOff || thoughtOnly || working || stillOpen || msg.truncated || toolXml.looksLikeXmlTool(raw) || toolXml.looksLikeUnfinishedToolTurn(raw));
      const talkCap = mustHandOff ? 4 : ((working || stillOpen) ? 6 : 2);
      const budgetOk = unlimited || orderedStart || forcedDispatch || compact.thinkBudgetOpen({ thinkUsed: usedNow, thinkLimit, implementing });
      if (!beforeStart && unfinished && softRetry < talkCap && (unlimited || orderedStart || round < SAFETY_MAX_ROUNDS - 1) && budgetOk) {
        softRetry += 1;
        if (mustHandOff) forceTool = { type: 'function', function: { name: 'call_worker' } };
        else if (mustDispatch || thoughtOnly || working || stillOpen) forceTool = true;
        diag.log('agent', '回复未完成或工具调用未发出，继续本轮', {
          truncated: !!msg.truncated,
          preview: raw.slice(0, 400)
        });
        onEvent({ type: 'rewrite_text', text: toolXml.stripXmlTools(asText(msg.content)) });
        onEvent({ type: 'status', text: msg.truncated ? '输出被截断，正在继续…' : (toolsAlready ? '接着上一轮工具结果继续…' : '工具调用未发出，正在重试…') });
        messages.push({
          role: 'user',
          content: msg.truncated
            ? '上一段输出被截断了。请从断开处继续；如果要读文件或列目录，请直接发起 function/tool call，不要把调用写成正文。'
            : (mustHandOff
              ? '还没有派工，文件没有改。请立刻调用 call_worker，role 填 code，把任务写全。不要再搜索，不要用一段说明收工。'
              : ((working || stillOpen)
              ? (agiBrain
                ? '这句是过程，不是结果。AGI 开着，禁止 call_worker。立刻自己调用 edit_file、write_file、run_command 或桌面工具。做完再向用户汇报，不要停在「正在」。'
                : '这句是过程，不是结果。请立刻用 tool call 把你刚说的下一步做掉。要改文件就调用 call_worker。做完再向用户汇报，不要停在「正在」。')
              : (agiBrain
                ? '系统没有收到 tool call，这一步没有执行。AGI 开着，禁止 call_worker。请立刻调用 read_file、edit_file、run_command 或桌面工具。不要只写思考。'
                : '系统没有收到 tool call，这一步没有执行。请立刻用接口提供的 function/tool call 调用 list_dir、read_file、search_text、map_lookup 或 call_worker。不要只写思考，不要把调用写成正文。')))
        });
        continue;
      }
      if (!agiBrain && (orderedStart || forcedDispatch) && !handedOff && (roleTag || 'brain') === 'brain' && workers && workers.code && round < SAFETY_MAX_ROUNDS - 1) {
        forceTool = { type: 'function', function: { name: 'call_worker' } };
        messages.push({ role: 'user', content: START_WORK_NUDGE });
        continue;
      }
      if (agiBrain && !toolsAlready && softRetry < 4 && round < SAFETY_MAX_ROUNDS - 1) {
        softRetry += 1;
        forceTool = true;
        messages.push({ role: 'user', content: AGI_SELF_NUDGE });
        onEvent({ type: 'status', text: 'AGI 已开，由大脑自己做…' });
        continue;
      }
      if (!agiBrain && !orderedStart && !userAskedQuestion(orderText) && !forcedDispatch && !handedOff && (roleTag || 'brain') === 'brain' && !implementing && !waitStartNudged && round < SAFETY_MAX_ROUNDS - 1) {
        waitStartNudged = true;
        messages.push({ role: 'user', content: WAIT_START_NUDGE });
        onEvent({ type: 'status', text: '还没开工，先复述并等你说开始…' });
        continue;
      }
      if (thoughtOnly) {
        finalText = asText(msg.reasoning_content);
        msg.content = finalText;
        onEvent({ type: 'rewrite_text', text: finalText });
      }
      if (!agiBrain && orderedStart && (roleTag || 'brain') === 'brain' && workers && workers.code && !filesLanded(snap) && round < roundCap - 1) {
        forceTool = { type: 'function', function: { name: 'call_worker' } };
        onEvent({ type: 'rewrite_text', text: '' });
        messages.push({ role: 'user', content: KEEP_DISPATCH_NUDGE });
        continue;
      }
      answered = true;
      break;
    }

    const runOneTool = async (tc) => {
      const name = tc.function?.name || '';
      if (DESKTOP_TOOLS.has(name)) agiUsed = true;
      let args = {};
      try {
        args = toolXml.repairJsonArgs(tc.function?.arguments || '{}');
      } catch {
        args = {};
      }
      const detail = args.path || args.query || args.question || args.command || (args.task ? String(args.task).slice(0, 80) : '');
      if (name === 'brain_pressure') {
        return { tc, name, args, result: '已在后台记录。不要向用户提到压力，直接回答用户的问题。' };
      }
      onEvent({
        type: 'tool',
        name,
        status: 'running',
        detail,
        text: `${toolLabel[name] || name}${detail ? ` ${detail}` : ''}`
      });
      let result;
      const startedAt = Date.now();
      diag.log('agent', '开始执行工具', { round, name, detail: String(detail).slice(0, 200) });
      try {
        if (name === 'call_worker' && agiBrain) {
          result = 'AGI 已打开。禁止派单。改文件用 edit_file 或 write_file，命令用 run_command，看屏幕和键鼠用桌面工具，都由你自己调用。不要再调用 call_worker。';
        } else if (name === 'call_worker') {
          const role = String(args.role || 'code');
          const task = String(args.task || '').trim();
          const worker = workers && workers[role];
          if ((role === 'planning' || role === 'code') && !orderedStart && (roleTag || 'brain') === 'brain') {
            result = '用户本轮没有说开始。禁止派工。请复述目标、范围、约束、验收，结尾写：确认无误后回复「开始」，我再动手。不要再调用 call_worker。';
          } else if (role === 'planning') {
            if ((depth || 0) > 0 || !worker) {
              result = '当前没有规划模块。';
            } else if (!planningTaskReady(task)) {
              result = '还没写清你的理解，没有交给规划模块。请先自己读懂需求，再调用 call_worker，role 填 planning。task 写目标、范围、约束、验收，不要把用户原文原样转交。';
            } else {
              const wName = worker.model || worker.name || '规划';
              onEvent({ type: 'status', text: `正在规划 · ${wName}`, activeModel: wName, activeRole: 'planning' });
              const msg = await completeWithFallback({
                modelCfg: worker,
                messages: [
                  { role: 'system', content: '你是规划模块。你不直接接用户需求。只根据大脑已经理解并写给你的内容拆步骤、顺序和风险。不要改文件，不要向用户要需求。' },
                  { role: 'user', content: task }
                ],
                noTools: true,
                signal,
                onDelta: () => {},
                onWait: (sec) => onEvent({
                  type: 'status',
                  text: `规划模块处理中 · ${sec}`,
                  activeModel: wName,
                  activeRole: 'planning'
                })
              });
              planningDone = true;
              result = String(msg?.content || '').trim().slice(0, 6000) || '规划模块没有返回步骤。';
              result += '\n\n【交给大脑判断】这是给你的，不要转述给用户。不符合需求就改清目标、范围、约束、验收后再派。用户已经说了开始就去派代码，不要把方案拿去回复用户。';
            }
          } else if (role === 'code' && wantPlanning && !planningDone && !orderedStart) {
            result = '规划还没做。请先调用 call_worker，role 填 planning。task 写你已经理解的目标、范围、约束、验收，不要把用户原文原样转交。';
          } else if ((depth || 0) > 0 || !worker) {
            result = '当前没有可调用的实现模型。';
          } else if (!task || !workerTaskReady(task)) {
            needFacts = true;
            result = '任务不够具体，没有交给实现模型。请先读到要改的文件和方法，再调用 call_worker，补全路径、方法与行号、现状、目标、不要改的范围。';
          } else {
            const wName = worker.model || worker.name || role;
            handedOff = true;
            onEvent({ type: 'status', text: `正在调用 ${wName}（代码 · 实现）…`, activeModel: wName, activeRole: role });
            const workerOnEvent = (ev) => {
              if (!ev) return;
              if (ev.type === 'rewrite_text' || ev.type === 'text') {
                if (ev.text) onEvent({ type: 'reason', text: String(ev.text).slice(0, 1500) });
                return;
              }
              onEvent(ev);
            };
            const unityCode = workspace && typecheck.isUnity(workspace)
              ? '这是 Unity 工程。禁止跑测试、禁止启动 Unity、禁止进播放模式，不能用 git。改完只说明改了哪些文件，不要声称已经跑过。运行效果由用户在编辑器里看。'
              : '';
            const out = await agentLoop({
              modelCfg: worker,
              messages: [
                { role: 'system', content: `你是实现模型，不和用户对接。「开始」不约束你，禁止因为用户没说开始而停手或复述。大脑的派单就是开工令，立刻按派单改文件。派单里给出的绝对路径，文件已经存在就先 read_file 要改的那一段，再用 edit_file 把原文替换成新内容（old_string 从读到的内容原样复制，不带行号前缀）；新建文件或几乎整份重写才用 write_file。禁止用 run_command 跑 python/node/powershell 脚本改文件，禁止用它搜代码或列目录（用 search_text、list_dir）。edit_file 返回没找到或出现多次时，重新 read_file 那一段照抄再改。禁止说执行环境找不到，禁止要求把目录加进工作区。禁止因为找不到参考、锚点或生成逻辑而停手；派单里写明的目标就是依据，必须写入派单给出的文件。地图归纳不足时读原代码，不准猜。禁止读取 .cursor、AGENTS.md、CLAUDE.md 以及其他 AI 的技能和规则，只按本程序已选技能和这次派单做。遵循 UTF-8、中文注释和禁止改动范围。这一轮要改多个互不依赖的文件时，一次发出多条 edit_file / write_file，每条一个文件。同一个文件的多处修改按顺序逐条 edit_file。改完只列出这次实际写入的文件，没写进去的不要说改了。${unityCode}${houseStyle.promptBlock(false)}` },
                { role: 'user', content: task }
              ],
              workspace,
              extra,
              snap,
              onEvent: workerOnEvent,
              signal,
              lang,
              workingMemoryRef,
              waitForUserAnswer,
              maxRounds: thinkLimit,
              unlimitedRounds: unlimited,
              toolSpec: toolsFor('worker'),
              workers: null,
              roleTag: 'code',
              depth: (depth || 0) + 1
            });
            result = String(out || '').trim().slice(0, 2000) || '实现模型没有返回说明。';
            result += '\n\n【交给大脑判断】文件还没按需求写入时，禁止把这段告诉用户。用你已经读到的绝对路径和内容把改法写进新 task，立刻再派代码，直到写入。写入且符合需求后，才向用户说是你做成的。中途部下写错的，完成说明里点名。';
          }
        } else if (!agiBrain && !orderedStart && (roleTag || 'brain') === 'brain' && !(depth || 0) && HAND_OFF_TOOLS.has(name)) {
          result = '用户本轮没有说开始。禁止改文件。请复述目标、范围、约束、验收，结尾写：确认无误后回复「开始」，我再动手。';
        } else if (name === 'ask_user' && agiBrain) {
          result = 'AGI 开着。用户只管验收，其他事情你自己做完。禁止用 ask_user 把活交回用户，不要等「开始」。';
        } else if (!agiBrain && workers && workers.code && HAND_OFF_TOOLS.has(name) && !(depth || 0)) {
          result = '大脑不能直接改文件。请改用 call_worker，role 填 code。task 要写全路径、方法与行号、现状、目标行为、不要改的范围。';
        } else {
          result = await execTool(workspace, snap, name, args, onEvent, extra, signal, lang);
        }
        diag.log('agent', '工具执行完成', { name, 耗时毫秒: Date.now() - startedAt, 结果字符数: String(result || '').length });
      } catch (e) {
        if (e.code === 'working_memory_update' && workingMemoryRef) {
          workingMemoryRef.current = compact.patchWorking(workingMemoryRef.current, e.patch || {});
          result = `已更新工作记忆：${JSON.stringify(workingMemoryRef.current)}`;
          onEvent({ type: 'working_memory', workingMemory: workingMemoryRef.current });
        } else if (e.code === 'desktop_confirm') {
          onEvent({
            type: 'ask',
            question: e.ask.question,
            options: e.ask.options,
            allowFreeText: false,
            toolCallId: tc.id
          });
          onEvent({ type: 'status', text: '等你确认这一步桌面操作…' });
          const answer = typeof waitForUserAnswer === 'function' ? answerParts(await waitForUserAnswer(e.ask, signal)).text : '';
          if (answer.includes(RISK_ALLOW_TURN)) require('./desktop-hand').allowRiskyThisTurn();
          if (answer.includes(RISK_ALLOW) || answer.includes(RISK_ALLOW_TURN)) {
            try {
              result = `用户已允许。\n${await e.proceed()}`;
            } catch (err2) {
              result = `工具失败：${err2.message}`;
            }
          } else {
            result = '用户没有允许这一步，已取消。不要换个方式绕过去做同一件事；向用户说明还差这一步，由用户自己决定。';
          }
        } else if (e.code === 'ask_user') {
          onEvent({
            type: 'ask',
            question: e.ask.question,
            options: e.ask.options || [],
            allowFreeText: e.ask.allowFreeText !== false,
            toolCallId: tc.id
          });
          onEvent({ type: 'status', text: '等待你的回答…' });
          if (typeof waitForUserAnswer !== 'function') {
            result = '询问机制未接通，请在下一条消息里直接回答。';
          } else {
            const reply = answerParts(await waitForUserAnswer(e.ask, signal));
            const answer = reply.text;
            result = `用户回答：${answer || '（没写文字，只发了截图）'}`;
            if (reply.images.length) {
              const seen = await answerImagesForModel(reply.images, { modelCfg, signal, onEvent, lang });
              if (seen.text) result += `\n\n${seen.text}`;
              askImageParts.push(...seen.parts);
            }
            // [铆钉优化] 用户在大脑弹出的选项里点了「开始」：本轮当场放开写文件和派单，
            // 否则会出现点了开始却说「找不到写入工具」。其他 AI 请勿删除
            if (!orderedStart && (roleTag || 'brain') === 'brain' && (agiBrain || (workers && workers.code)) && askAnswerIsStart(answer)) {
              orderedStart = true;
              activeTools = toolsFor('brain', ['planning', 'code'].filter((r) => workers && workers[r]), true);
              const sys = messages[0];
              if (sys && sys.role === 'system' && typeof sys.content === 'string') {
                sys.content = sys.content.replace(/\n\n(开工门槛：|Start gate:)[^\n]*\n/g, '\n');
              }
              if (snap) snap.askStarted = true;
              result += agiBrain
                ? (replyLang.promptInEnglish(lang)
                  ? '\nThe user confirmed start. AGI is on. Do not call call_worker. Use edit_file, write_file, run_command, or the desktop tools yourself right away.'
                  : '\n用户已确认开始。AGI 开着，禁止派单。立刻自己调用 edit_file、write_file、run_command 或桌面工具，禁止再复述或再要开始。')
                : (replyLang.promptInEnglish(lang)
                  ? '\nThe user confirmed start. call_worker is now available. Call call_worker with role code right away; do not restate or ask again.'
                  : '\n用户已确认开始。现在 call_worker 已可用，立刻调用 call_worker，role 填 code，禁止再复述或再要开始。');
            }
          }
        } else {
          result = `工具失败：${e.message}`;
          diag.log('agent', '工具执行失败', { name, 耗时毫秒: Date.now() - startedAt, message: e && e.message });
        }
      }
      onEvent({
        type: 'tool',
        name,
        status: 'done',
        detail,
        text: `完成：${toolLabel[name] || name}${detail ? ` ${detail}` : ''}`
      });
      return { tc, name, args, result };
    };

    const waves = compact.splitToolWaves(calls, (tc) => {
      try { return toolXml.repairJsonArgs(tc.function?.arguments || '{}'); } catch { return {}; }
    });
    const fileParallelCap = 4;
    for (const wave of waves) {
      const runParallel = wave.parallel && wave.calls.length > 1;
      if (runParallel) {
        diag.log('agent', wave.kind === 'file' ? '并行执行不同文件' : '并行执行只读工具', { round, 数量: wave.calls.length });
      }
      const outs = [];
      if (!runParallel) {
        for (const tc of wave.calls) outs.push(await runOneTool(tc));
      } else {
        for (let i = 0; i < wave.calls.length; i += fileParallelCap) {
          const batch = wave.calls.slice(i, i + fileParallelCap);
          outs.push(...await Promise.all(batch.map(runOneTool)));
        }
      }
      for (const o of outs) {
        messages.push({
          role: 'tool',
          tool_call_id: o.tc.id,
          content: compact.clipToolResult(o.name, o.args, o.result, seenToolKeys)
        });
      }
      if (askImageParts.length) {
        messages.push({ role: 'user', content: [{ type: 'text', text: '这是我在回答里发给你的截图：' }, ...askImageParts.splice(0)] });
      }
      if (!workers && workspace) {
        for (const o of outs) {
          if ((o.name !== 'write_file' && o.name !== 'edit_file') || !o.args?.path) continue;
          try {
            let abs = path.resolve(workspace, String(o.args.path));
            try { abs = resolveWrite(workspace, extra, String(o.args.path).replace(/\\/g, '/')); } catch { /* 用上面的拼接路径 */ }
            const types = await typecheck.checkFile(workspace, abs);
            const hit = messages.find((m) => m.role === 'tool' && m.tool_call_id === o.tc.id);
            if (types && hit) hit.content += `\n\n【类型检查】\n${types.slice(0, 1500)}`;
          } catch { /* 类型检查失败不挡住这次写入 */ }
        }
      }
    }
    compact.shrinkOlderToolMessages(messages, 2);
    if (compact.callsIncludeImplement(calls) || handedOff) implementing = true;
    // 轮次只计思考。代码实现、以及思考用完之后的派工，都不占轮次
    const skipCount = tag === 'code' || implementing || thinkingClosed || (orderedStart && handedOff);
    if (!skipCount) {
      if (countAs === 'code') thinkUsed += 1;
      else brainUsed += 1;
    }
  }

  if (!answered && !signal?.aborted) {
    onEvent({ type: 'status', text: '正在整理最终回答…' });
    const wrapHint = implementing
      ? '实现轮次已达安全上限。请根据已经改过的内容写出完整的最终回答，不要再调用任何工具。'
      : (lastPhase === 'code'
        ? '代码轮次已用完。请根据已经改过的内容写出完整的最终回答，不要再调用任何工具。'
        : '大脑轮次已用完。请根据已经拿到的信息直接写出完整的最终回答；若还要改代码请在下一轮用户消息里继续，不要再只做搜索。');
    messages.push({
      role: 'user',
      content: wrapHint
    });
    try {
      const finalMsg = await completeWithFallback({
        modelCfg,
        messages,
        noTools: true,
        onDelta: (t) => onEvent({ type: 'text', text: t }),
        onReason: (t) => onEvent({ type: 'reason', text: t }),
        onWait: waitStatus(onEvent),
        signal
      });
      const text = asText(finalMsg.content);
      if (text) finalText = text;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      onEvent({ type: 'think', text: `收尾回答失败：${e.message}` });
    }
  }
  return orderedStart ? stripStartAsk(finalText) : finalText;
}

// 只摘有限的文本差异，给总结模块核对，避免把整文件再送一遍
function implementationDiffText(workspace, snap, changes) {
  const parts = [];
  let budget = 12000;
  const list = (changes || []).slice(0, 8);
  for (const change of list) {
    if (budget <= 0) break;
    const rel = String(change.path || '').replace(/\\/g, '/');
    let body = `${rel}（${change.action || 'write'}）`;
    try {
      const abs = path.resolve(workspace, rel);
      const size = fs.existsSync(abs) && fs.statSync(abs).isFile() ? fs.statSync(abs).size : 0;
      if (size > 200 * 1024) {
        body += '\n文件较大，只核对路径，不展开正文。';
      } else if (snap?.current?.id) {
        const hunks = snapshot.listFileHunks(workspace, snap.current.id, rel);
        const lines = [];
        // 只看前几处差异时，总结会漏掉主要改动，把「一致」判成无；放宽到 10 处，总长仍受 budget 限制
        for (const hunk of (hunks.hunks || []).slice(0, 10)) {
          for (const line of (hunk.removed || []).slice(0, 12)) lines.push(`- ${line}`);
          for (const line of (hunk.added || []).slice(0, 30)) lines.push(`+ ${line}`);
        }
        body += lines.length ? `\n${lines.join('\n')}` : '\n（没有可展示的文本差异）';
      }
    } catch (err) {
      body += `\n（差异读取失败：${err && err.message ? err.message : err}）`;
    }
    body = body.slice(0, Math.max(0, budget));
    budget -= body.length;
    parts.push(body);
  }
  if ((changes || []).length > list.length) parts.push(`其余 ${changes.length - list.length} 个文件未展开。`);
  return parts.join('\n\n');
}

// 从本轮工具调用和结果中整理动作轨迹，供 AGI 收工汇报使用
function turnActionText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const results = [];
  for (let i = 0; i < list.length; i++) {
    const message = list[i];
    if (message && message.role === 'tool') {
      const resultLines = String(message.content).split('\n');
      let result = resultLines.length ? resultLines[0] : '';
      if (result.length > 120) result = result.slice(0, 120);
      results.push({ id: message.tool_call_id, text: result });
    }
  }
  const lines = [];
  for (let i = 0; i < list.length; i++) {
    const message = list[i];
    if (!message || message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    for (let j = 0; j < message.tool_calls.length; j++) {
      const call = message.tool_calls[j];
      if (!call) continue;
      const fn = call.function || {};
      const name = String(fn.name || '工具');
      let args = {};
      try {
        if (typeof fn.arguments === 'string') args = JSON.parse(fn.arguments || '{}');
        else if (fn.arguments) args = fn.arguments;
      } catch (err) {
        args = {};
      }
      let detail = '';
      if (name === 'screen_look' || name === 'screen_read' || name === 'window_focus' || name === 'screen_wait') {
        detail = '';
      } else if (name === 'ui_act') {
        const action = String(args.action || args.name || '');
        let target = '';
        if (args.id !== undefined) target = ` [${args.id}]`;
        else if (args.number !== undefined) target = ` [${args.number}]`;
        let coordinates = '';
        if (args.x !== undefined || args.y !== undefined) coordinates = ` (${args.x}, ${args.y})`;
        detail = ` ${action}${target}${coordinates}`;
      } else if (name === 'keyboard_type') {
        detail = ` ${String(args.text || '')}`;
      } else if (name === 'keyboard_key') {
        detail = ` ${String(args.key || args.keys || args.name || '')}`;
      } else if (name === 'mouse_click') {
        detail = ` (${args.x}, ${args.y})`;
      } else if (name === 'mouse_drag') {
        if (args.points !== undefined) detail = ` ${JSON.stringify(args.points)}`;
        else detail = ` (${args.x1}, ${args.y1}) -> (${args.x2}, ${args.y2})`;
      } else if (name === 'write_file' || name === 'edit_file') {
        detail = ` ${String(args.path || '')}`;
      } else if (name === 'run_command') {
        detail = ` ${String(args.command || '')}`;
      }
      let result = '';
      for (let k = 0; k < results.length; k++) {
        if (results[k].id === call.id) {
          result = results[k].text;
          break;
        }
      }
      let line = `- ${name}${detail}`;
      if (result) line += `  ${result}`;
      lines.push(line);
    }
  }
  let text = lines.join('\n');
  if (text.length > 4000) text = text.slice(0, 4000);
  return text;
}

// [铆钉优化] 用户这轮只说「开始 / 好 / 改吧」时，真正的需求在前面：带上最近一条实质需求和大脑复述的方案，
// 否则总结模块拿「开始」两个字去核对，「一致」永远是「无」。其他 AI 请勿删除
function requirementText(userText, history) {
  const now = String(userText || '').trim();
  const items = Array.isArray(history) ? history : [];
  if (!startOrderedFor(now, items)) return now;
  let plan = '';
  let ask = '';
  for (let i = items.length - 1; i >= 0 && (!plan || !ask); i--) {
    const m = items[i];
    const text = String((m && m.content) || '').trim();
    if (!text) continue;
    if (m.role === 'assistant' && !plan && !ask) plan = text;
    else if (m.role === 'user' && !ask && !(text.length <= 40 && userOrderedStart(text))) ask = text;
  }
  const parts = [];
  if (ask) parts.push(`用户需求：\n${ask.slice(0, 3000)}`);
  if (plan) parts.push(`大脑复述、用户已确认的方案：\n${plan.slice(0, 3000)}`);
  if (now) parts.push(`本轮用户：${now}`);
  return parts.join('\n\n') || now;
}

// 实现改过文件之后调用总结槽。只出核对结论，附在正文后面，不盖掉大脑的说明
async function summarizeImplementation({ vs, modelCfg, userText, assistantText, workspace, snap, changes, onEvent, signal, messages, agiReport = false }) {
  const cfg = compact.pickSummaryCfg(vs, modelCfg);
  if (!cfg) return '';
  const label = cfg.model || cfg.name || '总结';
  onEvent({
    type: 'status',
    text: `正在用总结模型 ${label} 核对代码和需求…`,
    activeModel: label,
    activeRole: 'summary'
  });
  const diff = implementationDiffText(workspace, snap, changes);
  const prompt = agiReport
    ? [
      '你是总结模块。你不和用户对接，「开始」不约束你。桌面操作已经结束，只汇报本轮实际做过的事。',
      '只输出一段，一条一行写本轮实际做了什么，包括看了哪些屏幕、点了什么、跑了什么命令、改了哪些文件；若本轮没有任何实际操作就写「本轮只是回答，没有动手」。只依据动作轨迹和改动说明汇报，不要输出其他段落或评价。',
      `【本轮动作轨迹】\n${turnActionText(messages) || '（本轮没有工具调用）'}`,
      `【改动说明】\n${String(assistantText || '').slice(0, 2000)}`
    ].join('\n\n')
    : [
      '你是总结模块。你不和用户对接，「开始」不约束你。实现已经结束，你只核对，不改文件，不给新的实现方案。',
      // [铆钉优化] 用户要求总结只保留「已更改」一段，去掉未更改/一致/不一致。其他 AI 请勿加回
      '根据下面的代码差异，用中文只输出一段「已更改：」，列出这次代码差异里实际改到的内容，一条一行，写清改了哪个文件的什么功能。没有改动就只写「已更改：无」。',
      '不要输出「未更改」「一致」「不一致」或其他段落，不要评价是否符合需求。',
      '不准把收工说明当成已经改完的证据，以代码差异为准。',
      ...(workspace && typecheck.isUnity(workspace)
        ? ['这是 Unity 工程。不要要求跑测试或进播放模式。']
        : []),
      '',
      `【用户需求】\n${String(userText || '').slice(0, 4000)}`,
      `【改动说明】\n${String(assistantText || '').slice(0, 2000)}`,
      `【代码差异】\n${diff || '（没有读到差异）'}`
    ].join('\n\n');
  const msg = await completeWithFallback({
    modelCfg: cfg,
    messages: [
      { role: 'system', content: '只输出核对结论。不要调用工具。' },
      { role: 'user', content: prompt }
    ],
    noTools: true,
    signal,
    onDelta: () => {},
    onWait: (sec) => onEvent({
      type: 'status',
      text: `总结模型核对中 · ${sec}`,
      activeModel: label,
      activeRole: 'summary'
    })
  });
  const body = asText(msg?.content).trim();
  if (body) return body;
  // [铆钉优化] 思考模型常把「已更改」只放在思考里，正文是空的。只读正文时界面收工会清掉核对状态，总结不出现。其他 AI 请勿改回只读 content
  return extractReason(msg).trim();
}

async function runTurn({
  workspace,
  appRoot,
  modelCfg,
  history,
  userText,
  attachments,
  contextPaths,
  skill,
  rules,
  allSkills,
  onEvent,
  signal,
  workingMemory,
  contextSummary,
  waitForUserAnswer,
  extraFolders,
  maxAgentRounds,
  unlimitedRounds
}) {
  // 一下命令就停住虚拟光标，这轮结束再跟着，避免写代码时置顶窗拖死系统鼠标
  try { require('./desktop-hand').hold(); } catch { /* 桌面手未就绪时忽略 */ }
  try { brainPressure.noteUser(workspace, userText); } catch { /* 压力没记上也不打断这轮 */ }
  try {
  if (!modelCfg) {
    throw new Error('请先选择模型');
  }
  if (isZbaingAi(modelCfg)) {
    // zbaingAi 走本地 Python 引擎，不需要 API 地址或 GGUF 文件
  } else if (isLocalGguf(modelCfg)) {
    const dir = store.load().modelsDir || store.defaultModelsDir();
    if (!localLlm.resolveGgufPath(modelCfg, dir)) {
      throw new Error('未找到本地 GGUF 模型。请把 .gguf 文件放到本地模型目录，并在输入框旁选择。');
    }
  } else if (!modelCfg.baseUrl || !modelCfg.model) {
    throw new Error('请先在设置中配置 API 模型');
  }

  const extra = extraRoots(appRoot, workspace, extraFolders);
  const persona = skillsLib.loadPersona(appRoot).body || '';
  const snap = { current: null };
  const vs = store.load();
  const codeWorker = codeWorkerOf(vs, modelCfg);
  const planningWorker = planningWorkerOf(vs, modelCfg);
  const detectedForPlan = assembly.detectRoles(userText, { hasImages: false, contextChars: 0 });
  // 沿用原来会叫规划的场合：话里有规划/方案，或这轮要改代码且挂了代码槽。顺序改成大脑先理解再调用
  const wantPlanning = !!planningWorker && (
    detectedForPlan.includes('planning') || (detectedForPlan.includes('code') && !!codeWorker)
  );
  const workerRoles = [];
  if (planningWorker) workerRoles.push('planning');
  if (codeWorker) workerRoles.push('code');
  const loopWorkers = workerRoles.length
    ? {
      ...(planningWorker ? { planning: planningWorker } : {}),
      ...(codeWorker ? { code: codeWorker } : {})
    }
    : null;
  const turnStart = startOrderedFor(userText, history);
  const loopTools = workerRoles.length ? toolsFor('brain', workerRoles, turnStart) : undefined;
  const roundLimit = store.clampAgentRounds(maxAgentRounds != null ? maxAgentRounds : vs.maxAgentRounds);
  const vis = assembly.visionFrom(vs);
  const lang = replyLang.resolve({ locale: vs.locale, userText, history });
  // 挂了看图槽位就走辅助模型；不要因为接口「支持看图」开关把组装的模型跳过
  const useHelper = !!(vis.model);
  const vision = modelSupportsVision(modelCfg);
  const visionHint = noVisionHint(modelCfg);
  if (attachments && attachments.length) onEvent({ type: 'status', text: '正在解析附件…' });
  const { parts, extraTexts, skippedImages } = await attachmentsToParts(attachments, {
    vision,
    signal,
    noVisionHint: visionHint,
    skipImageNote: useHelper
  });
  if (skippedImages.length && !useHelper) {
    onEvent({ type: 'think', text: `当前模型看不到图片，已改为文字说明。${visionHint}` });
  }
  const ctxChunks = [];
  if (contextPaths && contextPaths.length) onEvent({ type: 'status', text: '正在读取引用文件…' });
  for (const p of contextPaths || []) {
    try {
      const abs = resolveRead(workspace, extra, p);
      const ext = path.extname(abs).toLowerCase();
      if (isImageExt(ext)) {
        const parsed = await parseAttachment(abs, { signal });
        if (parsed.dataUrl) {
          if (vision) pushVision(parts, parsed.dataUrl);
          else skippedImages.push(parsed.dataUrl);
        }
        ctxChunks.push(`@${p}（图片文件）`);
        continue;
      }
      if (isDocumentExt(ext)) {
        const parsed = await parseAttachment(abs, { signal });
        ctxChunks.push(`@${p}\n${parsed.text || ''}`);
        if (parsed.images?.length) {
          if (vision) {
            for (const img of parsed.images) pushVision(parts, img.dataUrl);
          } else {
            for (const img of parsed.images) skippedImages.push(img.dataUrl);
            ctxChunks.push(`（文档内含 ${parsed.images.length} 张图，你看不到画面。${visionHint}）`);
          }
        }
      } else {
        const bigNote = bigFileNote(abs);
        if (bigNote) {
          ctxChunks.push(`@${p}\n${bigNote}`);
        } else {
          const loaded = readTextFile(abs);
          ctxChunks.push(loaded.binary ? `@${p}（二进制文件）` : `【文件】${p}\n${loaded.text}`);
        }
      }
    } catch (e) {
      ctxChunks.push(`@${p} 读取失败：${e.message}`);
    }
  }

  // 项目地图召回：本地读已生成的地图打分，命中模块与方法行号直接进提示词（不调模型、不建向量）
  if (workspace && String(userText || '').trim()) {
    try {
      const block = codeIndex.buildPromptBlock(workspace, userText, extra);
      if (block) extraTexts.push(block);
    } catch (e) {
      diag.log('map', '地图注入失败，本轮跳过', { message: e && e.message });
    }
  }

  if (skippedImages.length && vis.model) {
    const label = vis.model;
    const list = skippedImages.slice(0, MAX_VISION_AGENT_IMAGES);
    onEvent({
      type: 'status',
      text: `正在用看图模型 ${label} 识别图片（共 ${list.length} 张）…`,
      activeModel: label,
      activeRole: 'vision'
    });
    diag.log('agent', '路由到看图模型', { model: label, 端点: vis.endpoint || '', 张数: list.length });
    const visionResults = [];
    const failNotes = [];
    for (let i = 0; i < list.length; i++) {
      const dataUrl = list[i];
      onEvent({ type: 'status', text: `正在识别第 ${i + 1}/${list.length} 张图片…` });
      try {
        const text = await visionRecognize({
          model: label,
          mmproj: vis.mmproj,
          endpoint: vis.endpoint,
          dataUrl,
          signal,
          onWait: visionWait(onEvent),
          lang,
          apiKey: vis.apiKey,
          protocol: vis.protocol
        });
        visionResults.push(`【图片识别结果】\n${text}`);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        diag.log('vision', '看图失败', { message: e && e.message });
        failNotes.push(e.message || String(e));
      }
    }
    if (visionResults.length) {
      extraTexts.push('—— 以下是看图模型对图片的识别内容（仅文字，无画面） ——');
      extraTexts.push(visionResults.join('\n\n'));
    }
    if (failNotes.length && !visionResults.length) {
      extraTexts.push(`【图片识别失败】${failNotes[0]}`);
    }
  }

  // [铆钉优化] 生图由大脑自己调用 generate_media，提示词由大脑按对话整理；只有不会调用工具的 zbaing 引擎才在开口前按原话自动生成。
  // 以前一律开口前按原话生成，「按上面的提示词生成」会把这句话本身当画面，大脑手里也没有生图工具。其他 AI 请勿改回开口前自动生成
  if (isZbaingAi(modelCfg) || isZbaingModule(modelCfg)) {
    await runGenerateSlots({ vs, userText, workspace, extra, extraTexts, onEvent, signal, snap, lang });
  } else {
    const genRoles = assembly.detectRoles(userText, { hasImages: false, contextChars: 0 })
      .filter((r) => assembly.GEN_ROLE_IDS.includes(r));
    if (genRoles.length) {
      const kinds = Object.keys(GEN_KIND_ROLE).filter((k) => genRoles.includes(GEN_KIND_ROLE[k]));
      extraTexts.push(`【生成提示】用户这轮要生成内容（${kinds.join('、')}）。请调用 generate_media，kind 填 ${kinds.join(' 或 ')}，prompt 写你按对话整理好的完整画面描述；要几张就调用几次。生成不需要用户说「开始」。`);
    }
  }

  const helperRoles = assembly.detectRoles(userText, {
    hasImages: skippedImages.length > 0,
    contextChars: ctxChunks.join('\n').length + extraTexts.join('\n').length
  }).filter((r) => assembly.TEXT_HELPER_IDS.includes(r) && r !== 'planning');
  if (helperRoles.includes('code') && codeWorker) {
    // 规划不在开工前读需求。大脑理解后再 call_worker，role 填 planning。
    // 总结不在开工前预处理。等这轮真的改过文件，再单独调用总结模块核对。
    const orderedRoles = [];
    const preferredRoles = ['summary', 'code'];
    for (const preferredRole of preferredRoles) {
      if (helperRoles.includes(preferredRole)) orderedRoles.push(preferredRole);
    }
    for (const existingRole of helperRoles) {
      if (!orderedRoles.includes(existingRole)) orderedRoles.push(existingRole);
    }
    helperRoles.splice(0, helperRoles.length, ...orderedRoles);
  }
  for (const role of helperRoles) {
    if (role === 'code' && codeWorker) continue;
    const candidates = assembly.roleCandidates(vs, role);
    if (!candidates.length) continue;
    const roleName = (assembly.ROLES.find((x) => x.id === role) || {}).name || role;
    let used = false;
    for (const cand of candidates) {
      const helperCfg = assembly.slotToModelCfg(cand.slot, vs);
      if (!helperCfg) continue;
      if (helperCfg.type === 'zbaingModule') helperCfg._helperRole = role;
      const sameAsPrimary = isLocalGguf(helperCfg) && isLocalGguf(modelCfg)
        ? (helperCfg.model || helperCfg.modelPath) === (modelCfg.model || modelCfg.modelPath)
        : helperCfg.id && helperCfg.id === modelCfg.id;
      if (sameAsPrimary) continue;
      const helperLabel = helperCfg.model || helperCfg.name || role;
      const srcHint = cand.source === 'assembly' ? '组合' : (cand.source === 'fallback' ? '备用' : '全局');
      onEvent({
        type: 'status',
        text: `正在用${roleName}模型 ${helperLabel}（${srcHint}）预处理…`,
        activeModel: helperLabel,
        activeRole: role
      });
      diag.log('agent', '路由到辅助模型', { role, model: helperLabel, source: cand.source });
      try {
        const currentMaterial = [userText, extraTexts.join('\n\n'), ctxChunks.join('\n\n')].filter(Boolean).join('\n\n');
        const helperPacked = compact.trimHistoryLocal((history || []).filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : m.text || ''
        })), contextSummary || '');
        const helperHistory = compact.collapseDuplicateFullText(helperPacked.history, currentMaterial);
        const helperDialog = helperHistory.map((m) => `${m.role === 'user' ? '用户' : '助手'}：${String(m.content || '')}`).join('\n\n');
        const material = [currentMaterial.slice(0, 16000), helperDialog && `【近期对话】\n${helperDialog.slice(0, 6000)}`, helperPacked.contextSummary && `【较早对话摘要】\n${helperPacked.contextSummary.slice(0, 2000)}`]
          .filter(Boolean).join('\n\n').slice(0, 24000);
        const msg = await completeWithFallback({
          modelCfg: helperCfg,
          messages: [
            { role: 'system', content: assembly.helperPrompt(role, lang) },
            { role: 'user', content: material || '请根据材料给出结果' }
          ],
          noTools: true,
          signal,
          onDelta: () => {},
          onWait: (sec) => onEvent({
            type: 'status',
            text: `${roleName}模型处理中 · ${sec}`,
            activeModel: helperLabel,
            activeRole: role
          })
        });
        const out = String(msg?.content || '').trim();
        if (!out) throw new Error('辅助模型无输出');
        extraTexts.push(`—— 以下是${roleName}模型「${helperLabel}」的预处理结果 ——`);
        extraTexts.push(out.slice(0, 12000));
        onEvent({ type: 'think', text: `${roleName}预处理完成（${srcHint}）` });
        used = true;
        break;
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        onEvent({ type: 'think', text: `${roleName}（${srcHint}）失败：${e.message}` });
        diag.log('agent', '辅助模型失败，尝试下一候选', { role, source: cand.source, message: e && e.message });
      }
    }
    if (!used) { /* 全部失败则跳过，主模型继续 */ }
  }

  // 只有 zbaing 系本地引擎（无自带联网）才注入本地联网搜索；其他模型自带联网能力，跳过以省时省 token
  if (isZbaingAi(modelCfg) || isZbaingModule(modelCfg)) {
    onEvent({ type: 'think', text: '正在判断是否需要联网搜索…' });
    if (webSearch.needsWebSearch(userText, {
      contextChars: ctxChunks.join('\n').length,
      hasImages: skippedImages.length > 0
    })) {
      onEvent({ type: 'status', text: '正在联网搜索…' });
      onEvent({ type: 'think', text: '需要上网核实，正在搜索（本轮一次）…' });
      try {
        const found = await webSearch.search({ query: userText, sites: vs.searchSites, signal });
        const block = webSearch.formatBlock(found, lang);
        if (block) {
          extraTexts.unshift(block);
          onEvent({ type: 'think', text: `已注入 ${found.hits.length} 条搜索结果，开始思考` });
          diag.log('agent', '联网搜索已注入', { 条数: found.hits.length, query: found.query });
        } else {
          onEvent({ type: 'think', text: '联网搜索没有可用结果，开始思考' });
        }
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        diag.log('agent', '联网搜索失败', { message: e && e.message });
        onEvent({ type: 'think', text: `联网搜索失败：${e.message}，开始思考` });
      }
    } else {
      onEvent({ type: 'think', text: '无需联网，开始思考' });
    }
  }

  const hasNativeImages = parts.some((p) => p.type === 'image_url');
  const hasHelperText = extraTexts.some((t) => t.includes('【图片识别结果】'));
  const visionMode = hasHelperText && hasNativeImages ? 'mixed' : hasNativeImages ? 'native' : hasHelperText ? 'helper' : '';

  if (workspace) {
    const remember = memory.parseRememberDirective(userText);
    if (remember) {
      try {
        if (/喜欢|偏好|习惯|总是|不要给我|请用/.test(remember)) {
          await memoryGlobal.addPref({ summary: remember, pinned: true, source: 'user' });
          onEvent({ type: 'think', text: `已写入全局偏好：${remember.slice(0, 80)}` });
        } else {
          memory.addUserMemory(workspace, {
            summary: remember,
            paths: contextPaths || [],
            pinned: true,
            kind: 'pin'
          });
          onEvent({ type: 'think', text: `已钉住长期记忆：${remember.slice(0, 80)}` });
        }
      } catch (e) {
        diag.log('memory', '显式记住失败', { message: e && e.message });
      }
    }
  }

  if (isZbaingAi(modelCfg) && !workspace && (zbaingWantsExplore(userText) || zbaingSearchQuery(userText))) {
    // 不往对话里塞「请先打开」模板。workspace 空由引擎自己生成。
  } else if (isZbaingAi(modelCfg) && workspace && zbaingWantsExplore(userText)) {
    onEvent({ type: 'status', text: '正在读取工作区…' });
    try {
      await zbaingPreflightTools({ workspace, extra, userText, snap, onEvent, signal, lang });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      diag.log('agent', 'zbaing 工作区预读失败', { message: e && e.message });
    }
  } else if (isZbaingAi(modelCfg) && workspace && zbaingSearchQuery(userText)) {
    onEvent({ type: 'status', text: '正在搜索代码…' });
    try {
      await zbaingPreflightTools({ workspace, extra, userText, snap, onEvent, signal, lang });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      diag.log('agent', 'zbaing 搜索预读失败', { message: e && e.message });
    }
  }

  const workingMemoryRef = { current: compact.normalizeWorking(workingMemory) };
  let rollingSummary = String(contextSummary || '');
  let hist = (history || []).filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : m.text || ''
  }));
  // 本地裁掉过早对话，不另调模型；长会话每轮少带几十万 token，小改动才不会等很久
  {
    const packed = compact.trimHistoryLocal(hist, rollingSummary);
    hist = packed.history;
    rollingSummary = packed.contextSummary;
    if (packed.didTrim) onEvent({ type: 'think', text: '已裁掉更早对话，只保留最近几轮全文' });
  }

  let memoryEntries = [];
  let globalPrefs = [];
  try {
    memoryEntries = workspace
      ? await memory.recall(workspace, { userText, paths: contextPaths || [] })
      : [];
  } catch {
    memoryEntries = workspace ? memory.recallSync(workspace, { userText, paths: contextPaths || [] }) : [];
  }
  try {
    globalPrefs = await memoryGlobal.recallPrefs(userText, contextPaths || []);
  } catch {
    globalPrefs = memoryGlobal.listPrefs().filter((p) => p.pinned).slice(0, 6);
  }
  const profile = memoryGlobal.getProfile();

  const userContent = [];
  const textBlock = [userText, extraTexts.join('\n\n'), ctxChunks.join('\n\n')].filter(Boolean).join('\n\n');
  hist = compact.collapseDuplicateFullText(hist, textBlock);
  if (parts.length) {
    userContent.push({ type: 'text', text: textBlock || '请查看附件' });
    userContent.push(...parts);
  }

  const zbaingChat = isZbaingAi(modelCfg);
  const mergeTurns = (arr) => {
    const slim = [];
    for (const m of arr || []) {
      if (slim.length && slim[slim.length - 1].role === 'user' && m.role === 'user') {
        slim[slim.length - 1] = m;
      } else {
        slim.push(m);
      }
    }
    return slim;
  };
  const slimZbaingHist = (histMsgs) => {
    const junk = /^(好。|嗯。|行。|好|嗯|好的。)$/;
    const poison = /没有返回内容|没有生成到文字|只算我|贴的 zbaing/i;
    const kept = (histMsgs || []).filter((m) => {
      if (m.role === 'user') return !!String(m.content || '').trim();
      if (m.role !== 'assistant') return false;
      const t = String(m.content || '').trim();
      if (!t || junk.test(t) || poison.test(t)) return false;
      return true;
    });
    return mergeTurns(kept).slice(-6);
  };
  // 较早的工具结果压成短摘要，避免每轮重发巨量旧内容（最近 3 条保留全文）
  const ageToolHistory = (histMsgs) => {
    const toolIdx = [];
    (histMsgs || []).forEach((m, i) => { if (m.role === "tool") toolIdx.push(i); });
    const keepFrom = toolIdx.length > 3 ? toolIdx[toolIdx.length - 3] : -1;
    return (histMsgs || []).map((m, i) => {
      if (m.role !== "tool" || i >= keepFrom) return m;
      const text = String(m.content || "");
      if (text.includes("【文件】") || text.includes("【全文】")) return m;
      if (text.length <= 600) return m;
      return Object.assign({}, m, { content: text.slice(0, 600) + "\n…（较早的工具结果已省略，需要时重新调用工具）" });
    });
  };
  const buildMessages = (histMsgs, summaryText) => {
    const agedHist = ageToolHistory(histMsgs);
    const userMsg = { role: 'user', content: parts.length ? userContent : textBlock };
    if (zbaingChat) {
      return mergeTurns([...slimZbaingHist(histMsgs), userMsg]);
    }
    const luna = /luna/i.test(`${modelCfg?.model || ''} ${modelCfg?.name || ''}`);
    const agiNow = desktopOn();
    const lunaLine = !luna ? '' : (agiNow
      ? (replyLang.promptInEnglish(lang)
        ? '\n\nLuna: AGI is on. The user only accepts the result. Do not wait for start. Call screen_read first, then finish the files, commands, and desktop actions yourself. Do not call call_worker.\n'
        : '\n\nLuna：AGI 开着。用户只管验收。不要等「开始」。必须先调用 screen_read，然后自己改文件、跑命令、操作键鼠。禁止 call_worker。\n')
      : (turnStart
      ? (replyLang.promptInEnglish(lang)
        ? '\n\nLuna: the user said start this turn. Dispatch code with call_worker, role code. Text alone does not edit files.\n'
        : '\n\nLuna：用户这轮说了开始。派代码必须调用 call_worker，role 填 code。只有文字不会改文件。\n')
      : (replyLang.promptInEnglish(lang)
        ? '\n\nLuna: the user did not say start. Only the brain answers. You may read_file, search_text, and list_dir. Do not call call_worker. Do not hand off to the code model.\n'
        : '\n\nLuna：用户这轮没有说开始。只由大脑回答。可以 read_file、search_text、list_dir 查原因。禁止 call_worker，禁止派给代码模块。\n')));
    // [铆钉优化] 没说开始时写文件和派单工具是故意收起的，大脑必须知道原因，
    // 否则会对用户说「没有可用的文件写入工具」。其他 AI 请勿删除
    const gateLine = (agiNow || turnStart || !codeWorker) ? '' : (replyLang.promptInEnglish(lang)
      ? '\n\nStart gate: the user has not said "start" this turn, so file-writing and call_worker are intentionally unavailable. This is normal, not a missing tool. Never tell the user you lack a write tool or cannot edit files. If they want a change, restate what you will change (files, methods, goal) and end with: Reply "start" once confirmed and I will do it.\n'
      : '\n\n开工门槛：用户这轮还没说「开始」，所以写文件和派单工具是按规则暂时收起的，这是正常的，不是缺工具。禁止对用户说「没有写入工具」「不能改文件」「无法写入」。用户想改东西时，复述要改的文件、方法和目标，结尾写：确认无误后回复「开始」，我再动手。\n');
    return [
    {
      role: 'system',
      content: buildSystemPrompt({
        workspace,
        rules,
        skill,
        extra,
        allSkills,
        persona,
        visionMode,
        visionBridge: vis.model || '',
        lang,
        memoryEntries,
        globalPrefs,
        profile,
        workingMemory: workingMemoryRef.current,
        contextSummary: summaryText,
        zbaingBridge: isZbaingAi(modelCfg),
        brainHandsOff: !!codeWorker,
        hasPlanning: !!planningWorker
      }) + lunaLine + gateLine
    },
    ...agedHist,
    userMsg
  ];
  };

  let messages = buildMessages(hist, rollingSummary);

  onEvent({ type: 'roster', models: buildRoster(vs, modelCfg) });
  const modelLabel = modelCfg.model || modelCfg.name || modelCfg.id || '模型';
  if (isZbaingAi(modelCfg)) {
    onEvent({ type: 'status', text: `正在调用 ${modelLabel}...` });
  } else {
    onEvent({ type: 'think', text: `正在调用 ${modelLabel}...` });
  }
  let zbaingMeta = null;
  const trackEvent = (ev) => {
    if (ev.type === 'zbaing_meta') {
      zbaingMeta = { source: ev.source, prompt: ev.prompt, minConf: ev.minConf };
    }
    onEvent(ev);
  };
  let finalText;
  try {
    finalText = await agentLoop({
      modelCfg,
      messages,
      workspace,
      extra,
      snap,
      onEvent: trackEvent,
      signal,
      lang,
      workingMemoryRef,
      waitForUserAnswer,
      maxRounds: roundLimit,
      unlimitedRounds: !!unlimitedRounds,
      toolSpec: loopTools,
      workers: loopWorkers,
      roleTag: 'brain',
      depth: 0,
      wantPlanning,
      userOrder: userText,
      startOrdered: turnStart
    });
  } catch (e) {
    if (compact.isContextOverflowError(e)) {
      onEvent({ type: 'think', text: '上下文爆了，正在压缩后重试…' });
      const packed = await compact.compactHistory({
        history: hist,
        contextSummary: rollingSummary,
        modelCfg,
        summarySlotCfg: compact.pickSummaryCfg(vs, modelCfg),
        completeFn: completeWithFallback,
        lang,
        signal,
        onEvent
      });
      hist = packed.history;
      rollingSummary = packed.contextSummary;
      messages = buildMessages(hist, rollingSummary);
      finalText = await agentLoop({
        modelCfg,
        messages,
        workspace,
        extra,
        snap,
        onEvent: trackEvent,
        signal,
        lang,
        workingMemoryRef,
        waitForUserAnswer,
        maxRounds: roundLimit,
        unlimitedRounds: !!unlimitedRounds,
        toolSpec: loopTools,
        workers: loopWorkers,
        roleTag: 'brain',
        depth: 0,
        wantPlanning,
        userOrder: userText,
        startOrdered: turnStart
      });
    } else {
      throw e;
    }
  }

  const changes = snap.current?.manifest?.changes || [];
  if (snap.current && changes.length) {
    snapshot.captureAfter(workspace, snap.current);
    onEvent({
      type: 'files',
      snapshotId: snap.current.id,
      changes
    });
  }
  // [铆钉优化] 这轮只多了 generated/ 下的生成结果（图片、视频、文档）时不叫总结：没有代码差异可核对，汇报由大脑回复。其他 AI 请勿删
  const codeChanges = changes.filter((c) => !/^generated\//i.test(String(c.path || '').replace(/\\/g, '/')));
  if ((codeChanges.length || desktopOn()) && !signal?.aborted) {
    try {
      const verdict = await summarizeImplementation({
        vs, modelCfg, userText: requirementText(userText, history), assistantText: finalText,
        workspace, snap, changes: codeChanges, onEvent, signal, messages,
        agiReport: !codeChanges.length
      });
      if (verdict) {
        finalText = [finalText, `【总结】\n${verdict}`].filter(Boolean).join('\n\n');
      }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      diag.log('agent', '实现后总结失败', { message: e && e.message });
      finalText = [finalText, `【总结】总结模块没有完成核对：${e.message || e}`].filter(Boolean).join('\n\n');
    }
  }
  finalText = String(finalText || '')
    .split(/\r?\n/)
    .filter((line) => !/brain_pressure|train_pressure|压力\s*\d+\s*\/\s*100|压力满了|压力已经满|压力到顶|压力爆了/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const startedThisTurn = turnStart || !!(snap && snap.askStarted);
  if (!startedThisTurn && codeWorker) {
    finalText = fixNoWriteToolClaim(finalText, replyLang.promptInEnglish(lang));
  }
  if (startedThisTurn) {
    finalText = stripStartAsk(finalText);
    // 说了开始却一个文件都没写，不能让回复看起来像已经做完
    if (codeWorker && !filesLanded(snap) && !signal?.aborted) {
      finalText = [finalText, '【未改动】这轮没有写入任何文件。'].filter(Boolean).join('\n\n');
    }
  }
  const result = {
    text: finalText,
    snapshotId: snap.current?.id || null,
    changes,
    workingMemory: workingMemoryRef.current,
    contextSummary: rollingSummary,
    zbaingMeta
  };
  onEvent({
    type: 'done',
    text: finalText,
    snapshotId: result.snapshotId,
    changes,
    workingMemory: result.workingMemory,
    contextSummary: rollingSummary,
    zbaingMeta
  });

  // 记忆提炼不挡收工：改文件后的额外模型调用放到后台，界面先解锁
  const afterWork = async () => {
    if (signal?.aborted) return;
    if (workspace && changes.length) {
      try {
        const extractMsg = await completeWithFallback({
          modelCfg,
          messages: [
            { role: 'user', content: memory.extractPrompt({
              userText,
              changePaths: changes.map((c) => c.path),
              assistantText: finalText,
              lang
            }) }
          ],
          noTools: true,
          signal,
          onDelta: () => {},
          onWait: () => {}
        });
        const parsed = memory.parseExtractJson(asText(extractMsg?.content));
        if (parsed.length) memory.mergeEntries(workspace, parsed, { source: 'auto' });
      } catch (e) {
        if (e.name !== 'AbortError') diag.log('memory', '自动提炼失败', { message: e && e.message });
      }
    }
    // 纯闲聊才更新画像；改代码那轮再跑一次等于白等
    if (!changes.length && !isZbaingAi(modelCfg)) {
      try {
        const patchMsg = await completeWithFallback({
          modelCfg,
          messages: [{ role: 'user', content: memoryGlobal.profileExtractPrompt(userText, finalText) }],
          noTools: true,
          signal,
          onDelta: () => {},
          onWait: () => {}
        });
        const patch = memoryGlobal.parseProfilePatch(asText(patchMsg?.content));
        if (patch && Object.keys(patch).length) memoryGlobal.mergeProfilePatch(patch);
      } catch (e) {
        if (e.name !== 'AbortError') diag.log('memory', '画像更新失败', { message: e && e.message });
      }
    }
  };
  afterWork().catch((e) => diag.log('memory', '收工后处理失败', { message: e && e.message }));
  return result;
  } finally {
    try { require('./desktop-hand').release(); } catch { /* 没开桌面操作时不用收尾 */ }
  }
}

function listSkills(appRoot, workspace, order) {
  return skillsLib.loadAll(path.join(appRoot, 'skills'), workspace, order);
}

function listRules(appRoot, workspace) {
  return skillsLib.loadRules(path.join(appRoot, 'rules'), workspace);
}

// 用当前模型为项目地图的每个模块生成一句中文职责描述（AI 绘制）
async function describeProjectMap(modelCfg, mapData) {
  if (!modelCfg || !mapData || !Array.isArray(mapData.nodes) || !mapData.nodes.length) return mapData;
  const items = mapData.nodes.map((n) => ({ path: n.path, ext: n.ext || '', deps: (n.deps || []).slice(0, 10) }));
  const sys = {
    role: 'system',
    content: '你是项目地图分析助手。下面给出一个项目的文件模块清单及依赖关系。请为每个模块用一句中文（不超过 40 字）概括它承担的职责。只输出一个 JSON 数组，元素为 {"path": 原路径, "desc": 一句中文描述}，不要输出任何额外文字或代码块标记。'
  };
  const user = {
    role: 'user',
    content: '模块清单（path 为模块路径，deps 为它依赖的模块路径）：\n' + JSON.stringify(items)
  };
  const msg = await completeWithFallback({ modelCfg, messages: [sys, user], noTools: true });
  const raw = (msg && msg.content != null)
    ? (typeof msg.content === 'string' ? msg.content : (Array.isArray(msg.content) ? msg.content.map((c) => (c && c.text) || '').join('') : ''))
    : '';
  const arr = parseProjectMapJsonArray(raw);
  if (!arr) { diag.log('map', 'AI 返回的地图描述无法解析，保留静态结果'); return mapData; }
  const byPath = new Map();
  for (const it of arr) {
    if (it && it.path && it.desc) byPath.set(String(it.path), String(it.desc).slice(0, 80));
  }
  let filled = 0;
  for (const n of mapData.nodes) {
    const d = byPath.get(n.path);
    if (d) { n.desc = d; filled++; }
  }
  diag.log('map', 'AI 绘制完成', { filled, total: mapData.nodes.length });
  return mapData;
}

// 从模型可能夹带代码块或前后文字的回复里抽出 JSON 数组
function parseProjectMapJsonArray(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const arr = JSON.parse(t.slice(start, end + 1));
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}


module.exports = { runTurn, listSkills, listRules, toolsSpec, describeProjectMap };
