// Mock LLM server for edg-agent e2e tests.
// Pure Node (>=20) — no external dependencies.
// Listens on 127.0.0.1:4399 (override via MOCK_LLM_PORT).
//
// Implements a deterministic state machine based on the user messages in the
// request body, returning OpenAI-compatible responses for the agent loop.

import http from 'node:http';

const PORT = Number(process.env.MOCK_LLM_PORT ?? 4399);
const HOST = '127.0.0.1';
// --- Process-wide counters (exposed via /__stats) ---
let sawImage = false;
let reqCount = 0;
let sawSteer = false;
let sawHistory = false;
// 上传测试：mock 每发一次 upload 工具动作 +1（驱动 3 次 = 3：file input + 按钮 + 拖拽区）
let sawUpload = 0;
// 对话框测试：mock 每发一次 dialog 工具动作 +1（期望 2：confirm + prompt）
let sawDialog = 0;
// 见到 alert 自动应答回执（autoNote 拼进执行结果）
let sawAutoAlert = false;
// 见到「页面有未应答的原生对话框」拦截闸（故意发错动作触发）
let sawDialogGuard = false;
// 批量录入测试：mock 每发一次「提交」点击 +1（期望 = 任务数据行数）
let sawEntry = 0;
// 记忆测试：收到提炼请求（末条 user 含「提取值得长期记住的信息」）+1
let sawDistill = 0;
// 记忆测试：system prompt 带记忆段（「已知事实」）的请求数（用计数而非布尔锁存，
//  runner 按前后差值断言，mock 进程跨多次运行不复位也不影响）
let sawMemoryInjection = 0;
// 格式错误测试：think-only fixture 返回的请求数（按任务 key 区分任务间计数，
//  runner 用前后差值断言「连续 2 次即早退，不应有第 3 次」）。
let thinkOnlyServed = 0;
// 格式错误测试：refusal fixture 返回的请求数（同上用途）。
let refusalServed = 0;
let formatRecoveryServed = 0;
// 快路径测试：/v1/systemone（Jev mock）总调用数；快路径测试场景的调用序计数；
// 选中元素 id（即快路径直执点击、绕过 LLM）的次数
let sawJev = 0;
let sawJevSearch = 0;
let sawJevClick = 0;
// 每次请求的 body 字节数（≈ 完整 prompt 体积，含 system+历史+快照），用于 token 消耗分析
const reqBytes = [];

// --- Helpers ---

function msgText(m) {
  if (!m || m.content == null) return '';
  const c = m.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');
  }
  return '';
}

function hasImagePart(m) {
  return !!m && Array.isArray(m.content) && m.content.some(
    (p) => p && p.type === 'image_url' && p.image_url && typeof p.image_url.url === 'string'
  );
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': '*',
};

function buildSearchReply(lastUserContent, results) {
  if (typeof lastUserContent === 'string' && lastUserContent.includes('结果1: hello')) {
    return { tool: 'done', summary: '已完成搜索 hello，页面显示 3 条结果' };
  }
  if (results === 0) {
    const m = lastUserContent.match(/^\[(\d+)\] input[^\n]*placeholder="请输入关键词"/m);
    if (!m) return { tool: 'done', summary: '无法识别的场景' };
    return { tool: 'type', id: Number(m[1]), text: 'hello' };
  }
  if (results === 1) {
    const m = lastUserContent.match(/^\[(\d+)\] button[^\n]*"搜索"/m);
    if (!m) return { tool: 'done', summary: '无法识别的场景' };
    return { tool: 'click', id: Number(m[1]) };
  }
  return { tool: 'done', summary: '已完成搜索 hello，页面显示 3 条结果' };
}

function buildOrderReply(lastUserContent, results) {
  if (results === 0) {
    const m = lastUserContent.match(/^\[(\d+)\] input[^\n]*placeholder="姓名"/m);
    if (!m) return { tool: 'done', summary: '无法识别的场景' };
    return { tool: 'type', id: Number(m[1]), text: '张三' };
  }
  if (results === 1) {
    const m = lastUserContent.match(/^\[(\d+)\] input[^\n]*placeholder="密码"/m);
    if (!m) return { tool: 'done', summary: '无法识别的场景' };
    return { tool: 'type', id: Number(m[1]), text: '123456' };
  }
  if (results === 2) {
    const m = lastUserContent.match(/^\[(\d+)\] button[^\n]*"提交订单"/m);
    if (!m) return { tool: 'done', summary: '无法识别的场景' };
    return { tool: 'click', id: Number(m[1]) };
  }
  if (results === 3) {
    const m = lastUserContent.match(/^\[(\d+)\] button[^\n]*"删除订单"/m);
    if (!m) return { tool: 'done', summary: '无法识别的场景' };
    return { tool: 'click', id: Number(m[1]) };
  }
  return { tool: 'done', summary: '订单已完成' };
}

// --- Core state machine ---

function decideAction(messages) {
  const userMessages = Array.isArray(messages) ? messages.filter((m) => m && m.role === 'user') : [];
  const results = userMessages.filter((m) => msgText(m).startsWith('执行结果:')).length;
  const lastUser = userMessages[userMessages.length - 1];
  const last = lastUser ? msgText(lastUser) : '';
  const allUserText = userMessages.map((m) => msgText(m)).join('\n');
  const firstUserText = userMessages.length > 0 ? msgText(userMessages[0]) : '';
  const taskLine = (firstUserText.match(/^任务: ([^\n]+)/m) || [])[1] || '';

  // 记忆提炼轮：loop 在 done/max-steps 后追加的请求，末条 user 含固定标记。
  // 返回固定 JSON（注意：不是动作对象，无 tool 字段），loop 解析后合并入库。
  if (last.includes('提取值得长期记住的信息')) {
    sawDistill += 1;
    return {
      facts: ['用户公司的发票抬头是「示例科技有限公司」'],
      siteTips: ['搜索框要先点击放大镜图标再输入'],
    };
  }
  // 记忆场景：任务含「记忆测试」— 走 search.html 的搜索流程（type 关键词 +
  // click 搜索按钮 = 2 次页面动作，凑够提炼门槛）后 done，触发提炼轮；
  // 第二次任务时 system prompt 应已注入记忆段（sawMemoryInjection）。
  // 动作选择与 buildSearchReply 同构（e2e 已验证 click/type 路径；scroll 的
  // CDP 轮子路径无 runner 覆盖，不用它凑数）。
  if (taskLine.includes('记忆测试')) {
    // 不用「结果1: hello」当终态信号：第二次任务的首轮消息带正文摘录，
    // 里面残留上次搜索的结果文本，会误判成已完成。按 results 计数分流即可。
    if (results === 0) {
      const m = last.match(/^\[(\d+)\] input[^\n]*placeholder="请输入关键词"/m);
      if (!m) {
        console.log('[mock] 记忆测试 regex miss; last user msg:\n' + last.slice(0, 800));
        return { tool: 'done', summary: '记忆测试：找不到搜索输入框' };
      }
      return { tool: 'type', id: Number(m[1]), text: 'hello' };
    }
    if (results === 1) {
      const m = last.match(/^\[(\d+)\] button[^\n]*"搜索"/m);
      if (!m) return { tool: 'done', summary: '记忆测试：找不到搜索按钮' };
      return { tool: 'click', id: Number(m[1]) };
    }
    return { tool: 'done', summary: '记忆测试完成' };
  }
  if (taskLine.includes('插话测试')) {
    const steerMsg = userMessages.map((m) => msgText(m)).find((t) => t.includes('用户插话:'));
    if (steerMsg) {
      sawSteer = true;
      const m = steerMsg.match(/用户插话: ([^\n]+)/);
      return { tool: 'done', summary: `已收到插话: ${m ? m[1] : ''}` };
    }
    return { tool: 'scroll', direction: 'down' };
  }
  if (taskLine.includes('历史回顾')) {
    if (firstUserText.includes('此前本会话已完成的任务')) {
      sawHistory = true;
      return { tool: 'done', summary: '已看到历史' };
    }
    return { tool: 'done', summary: '没有看到历史' };
  }
  if (taskLine.includes('慢响应')) {
    return { tool: 'done', summary: '慢响应完成', __delay: 20000 };
  }
  // 批量录入场景：任务含「批量录入测试」— 数据来自 sidepanel 附件解析块
  // （首条 user 消息内「附件 xxx 的内容:\n」之后、「页面:」快照之前的 CSV 风格行）。
  // 每行 4 步：type 姓名 → type 部门 → type 电话 → click 提交；全部行完成后 done。
  // 模拟「本地 Excel 附件 → 逐条填进 web 表单并提交」的重复性输入循环。
  if (taskLine.includes('批量录入测试')) {
    const dataMatch = firstUserText.match(/的内容:\n([\s\S]+?)\n\n页面: /);
    if (!dataMatch) return { tool: 'done', summary: '批量录入测试：任务里找不到附件内容块' };
    const rows = dataMatch[1]
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.includes(', '))
      .map((l) => l.split(', ').map((x) => x.trim()));
    const perRow = 4;
    if (results < rows.length * perRow) {
      const step = results % perRow;
      const row = rows[Math.floor(results / perRow)];
      if (step < 3) {
        const ph = ['姓名', '部门', '电话'][step];
        const m = last.match(new RegExp(`^\\[(\\d+)\\] input[^\\n]*placeholder="${ph}"`, 'm'));
        if (!m) return { tool: 'done', summary: `批量录入测试：快照中找不到${ph}输入框` };
        return { tool: 'type', id: Number(m[1]), text: row[step] };
      }
      const m = last.match(/^\[(\d+)\] button[^\n]*"提交"/m);
      if (!m) return { tool: 'done', summary: '批量录入测试：快照中找不到提交按钮' };
      sawEntry += 1;
      return { tool: 'click', id: Number(m[1]) };
    }
    return { tool: 'done', summary: `批量录入完成，共 ${rows.length} 条` };
  }
  // 对话框场景：任务含「对话框测试」— 状态机按 last 内容推进（short-circuit 消息
  // 不含快照，results 计数不可靠，不能按步数分流）：
  // click 弹出提示 → 见 alert 自动关闭回执 → click 弹出确认 → 见确认框上抛 →
  // 故意发 scroll（验证拦截闸）→ 见「页面有未应答」→ dialog accept →
  // click 弹出输入 → 见输入框上抛 → dialog accept+text → done。
  if (taskLine.includes('对话框测试')) {
    if (last.includes('已确认输入对话框')) {
      if (!last.includes('输入: "VIP999"')) return { tool: 'done', summary: 'prompt 的 text 没有透传' };
      return { tool: 'done', summary: '对话框测试完成' };
    }
    if (last.includes('页面弹出输入对话框')) {
      if (!last.includes('"请输入优惠码"')) return { tool: 'done', summary: 'prompt 消息内容不对' };
      sawDialog += 1;
      return { tool: 'dialog', action: 'accept', text: 'VIP999' };
    }
    if (last.includes('已确认确认对话框')) {
      const m = last.match(/^\[(\d+)\] button[^\n]*"弹出输入"/m);
      if (!m) return { tool: 'done', summary: '找不到弹出输入按钮' };
      return { tool: 'click', id: Number(m[1]) };
    }
    if (last.includes('页面有未应答的原生对话框')) {
      sawDialogGuard = true;
      return { tool: 'dialog', action: 'accept' };
    }
    if (last.includes('页面弹出确认对话框')) {
      if (!last.includes('"确定要删除该订单吗？"')) return { tool: 'done', summary: 'confirm 消息内容不对' };
      sawDialog += 1;
      // 故意发非 dialog 动作：验证 loop 的冻结拦截闸
      return { tool: 'scroll', direction: 'down' };
    }
    if (last.includes('页面弹出 alert')) {
      if (!last.includes('库存不足')) return { tool: 'done', summary: 'alert 消息内容不对' };
      sawAutoAlert = true;
      const m = last.match(/^\[(\d+)\] button[^\n]*"弹出确认"/m);
      if (!m) return { tool: 'done', summary: '找不到弹出确认按钮' };
      return { tool: 'click', id: Number(m[1]) };
    }
    if (results === 0) {
      const m = last.match(/^\[(\d+)\] button[^\n]*"弹出提示"/m);
      if (!m) return { tool: 'done', summary: '找不到弹出提示按钮' };
      return { tool: 'click', id: Number(m[1]) };
    }
    return { tool: 'done', summary: `对话框测试：状态机未覆盖: ${last.slice(0, 120)}` };
  }
  if (taskLine.includes('多步测试')) {
    if (results < 6) return { tool: 'scroll', direction: 'down' };
    return { tool: 'done', summary: '多步完成' };
  }
  if (taskLine.includes('markdown测试')) {
    return {
      tool: 'done',
      summary: [
        '# 更新一览',
        '',
        '根据 [OpenClaw 博客](https://openclaw.ai/blog)，近期更新如下：',
        '',
        '## 最新更新',
        '',
        '### 1. macOS 新安装器',
        '- 原生安装器 UI，无需接触终端',
        '- 自动检测 `Claude` / `Codex` 配置',
        '- Windows 端 **NVIDIA RTX** 一键部署',
        '',
        '| 日期 | 内容 |',
        '| --- | --- |',
        '| Sep 3 | 安装器 |',
        '| Aug 30 | 2.0 大更新 |',
      ].join('\n'),
    };
  }

  // Upload scenario: 任务含「上传测试」— 从任务文本里 regex 抽出 txt 绝对路径。
  // results===0 → upload 可见 file input（type=file accept=".txt"）；
  // results===1 → upload 「选择文件」按钮（触发器路径）；
  // results===2 → upload 拖拽区（div 行文带「拖」字）— 由影子 input + 合成 drop 事件完成；
  // results>=3 → done。每次发 upload +1（sawUpload 期望 3）。
  const hasUploadTest = taskLine.includes('上传测试');
  if (process.env.MOCK_DEBUG === '1' && hasUploadTest) {
    console.error(`[mock-debug upload] results=${results}`);
  }
  if (hasUploadTest) {
    const pathMatch = taskLine.match(/(\/[\w./-]+\.txt)/);
    const uploadPath = pathMatch ? pathMatch[1] : '/private/tmp/edg-upload-fixture.txt';
    if (results === 0) {
      const m = last.match(/^\[(\d+)\] input[^\n]*type=file[^\n]*accept="\.[\w]+"/m);
      if (!m) return { tool: 'done', summary: '上传测试：快照里找不到可见 file input' };
      sawUpload += 1;
      return { tool: 'upload', id: Number(m[1]), paths: [uploadPath] };
    }
    if (results === 1) {
      const m = last.match(/^\[(\d+)\] button[^\n]*"选择文件"/m);
      if (!m) return { tool: 'done', summary: '上传测试：快照里找不到「选择文件」按钮' };
      sawUpload += 1;
      return { tool: 'upload', id: Number(m[1]), paths: [uploadPath] };
    }
    if (results === 2) {
      // 拖拽区：buildSnapshotMessage 只输出 role/type/accept/text，不输出 class。
      // 匹配 [N] div 行文含「拖」字（占位文案）。
      const m = last.match(/^\[(\d+)\] div[^\n]*"[^"\n]*拖[^"\n]*"/m);
      if (!m) return { tool: 'done', summary: '上传测试：快照里找不到拖拽区' };
      sawUpload += 1;
      return { tool: 'upload', id: Number(m[1]), paths: [uploadPath] };
    }
    return { tool: 'done', summary: '上传完成' };
  }

  const hasScrollTest = allUserText.includes('滚动测试');
  if (hasScrollTest) {
    if (results === 0) return { tool: 'scroll', direction: 'down' };
    return { tool: 'done', summary: '滚动完成' };
  }
  const hasBigform = allUserText.includes('长文档表单测试页');
  if (hasBigform) {
    if (results === 0) {
      const m = last.match(/^\[(\d+)\] input[^\n]*placeholder="用户名"/m);
      if (!m) return { tool: 'done', summary: '快照中找不到用户名输入框' };
      return { tool: 'type', id: Number(m[1]), text: 'demo' };
    }
    if (results === 1) {
      const m = last.match(/^\[(\d+)\] input[^\n]*placeholder="密码"/m);
      if (!m) return { tool: 'done', summary: '快照中找不到密码输入框' };
      return { tool: 'type', id: Number(m[1]), text: 'secret123' };
    }
    if (results === 2) {
      const m = last.match(/^\[(\d+)\] button[^\n]*"登录"/m);
      if (!m) return { tool: 'done', summary: '快照中找不到登录按钮' };
      return { tool: 'click', id: Number(m[1]) };
    }
    return { tool: 'done', summary: '已完成登录表单录入' };
  }
  const hasCascaderReact = allUserText.includes('级联React测试页');
  const hasCascaderVue = !hasCascaderReact && allUserText.includes('级联Vue测试页');
  if (hasCascaderReact || hasCascaderVue) {
    if (process.env.MOCK_DEBUG === '1') {
      console.error(`[mock-debug] results=${results} last user message:\n${last.slice(0, 3000)}\n---`);
    }
    const steps = hasCascaderReact
      ? ['请选择::input', 'Zhejiang', 'Hangzhou', 'Xihu']
      : ['请选择::input', '浙江', '杭州', '西湖'];
    if (results < steps.length) {
      const target = steps[results];
      if (target.endsWith('::input')) {
        const ph = target.slice(0, -'::input'.length);
        const m = last.match(new RegExp(`^\\[(\\d+)\\] input[^\\n]*placeholder="${ph}"`, 'm'));
        if (!m) return { tool: 'done', summary: '快照中找不到级联触发框' };
        return { tool: 'click', id: Number(m[1]) };
      }
      const m = last.match(new RegExp(`^\\[(\\d+)\\] li role=menuitemcheckbox[^\\n]*"${target}`, 'm'));
      if (!m) return { tool: 'done', summary: `快照中找不到级联项 ${target}` };
      return { tool: 'click', id: Number(m[1]) };
    }
    return {
      tool: 'done',
      summary: hasCascaderReact ? '已完成级联选择: Zhejiang / Hangzhou / Xihu' : '已完成级联选择: 浙江 / 杭州 / 西湖',
    };
  }
  const hasCanvas = allUserText.includes('画布测试页');
  const hasAskOptions = allUserText.includes('询问选项');
  if (hasAskOptions) {
    const m = last.match(/用户回答: ([^\n]+)/);
    if (m) return { tool: 'done', summary: `已收到选择: ${m[1]}` };
    return { tool: 'ask_user', question: '请选择处理方式', options: ['选项甲', '选项乙', '选项丙'] };
  }
  const hasFormatRecovery = allUserText.includes('格式容错');
  if (hasFormatRecovery) {
    // 旧版 retry prompt 关键词「格式错误：请只回复」已下线；分类器把它分流到 generic 路径，
    // 新 prompt 是中性「上轮回复无法解析。请直接输出一个 JSON 动作对象，不要输出 <think> 标签。」
    // 第一次返回纯 think（无 JSON）→ classifyFailure 判 think-only → 专用重试 prompt
    // 「请跳过思考过程，直接给出下一步的 JSON 动作对象」。
    // 第二次见到这个专用 prompt 就该返回正常 JSON 完成。
    if (last.includes('请跳过思考过程')) {
      formatRecoveryServed += 1;
      return { tool: 'done', summary: '格式重试后完成' };
    }
    return {
      __raw: '<think>The user wants me to output only a single JSON action object. I need to redo my response properly. I was outputti',
    };
  }
  // FORMAT_THINK_ONLY fixture：任务文本含此 sentinel。
  // 头两次（占位前的初始请求 + 专用重试 prompt 触发的二次请求）返回纯 think（无 JSON），
  // 触发分类器 think-only 路径 + 连续 2 次即终态的早退闸。runner 断言任务请求数 == 2，
  // 不应看到第 3 次请求。统计 thinkOnlyServed 供差值断言。
  if (taskLine.includes('FORMAT_THINK_ONLY')) {
    // 第一次：包含一个闭合 think（剥完为空 → 无 `{` → think-only）
    // 第二次：包含一个未闭合 think（剥完也是空 → 仍 think-only → 触发连续 2 次闸，任务终态）
    if (thinkOnlyServed === 0) {
      thinkOnlyServed += 1;
      return {
        __raw: '<think>Let me think step by step about what action to take here. The page shows a search form. I need to figure out the right click target. Should I click the input first or the button? Let me consider the layout again.',
      };
    }
    if (thinkOnlyServed === 1) {
      thinkOnlyServed += 1;
      return {
        // 未闭合 think：finish_reason=stop 但 think 没闭合 → 剥后仍空 → 仍 think-only
        __raw: '<think>Step 1: analyze. Step 2: consider. Step 3: maybe click. Step 4: reconsider. Step 5: still thinking',
      };
    }
    // 不应到达这里：runner 验证任务在第 2 次后即终态，第 3 次请求不会被发出来。
    // 防御性返回 done 以免后续 mock 卡死。
    return { tool: 'done', summary: 'FORMAT_THINK_ONLY: 第 3 次未预期' };
  }
  // FORMAT_REFUSAL fixture：任务文本含此 sentinel。
  // 一次返回「think + 抱歉...」→ classifyFailure 判 refusal → 一次即终态。
  // runner 断言任务请求数 == 1。
  if (taskLine.includes('FORMAT_REFUSAL')) {
    refusalServed += 1;
    return {
      __raw: '<think>This task is asking me to do something I should decline. Let me respond appropriately to the user.</think>\n抱歉，我无法执行该操作。这超出了我的能力范围。',
    };
  }
  const hasTrailingContent = allUserText.includes('尾随正文');
  if (hasTrailingContent) {
    return {
      __raw: '{"tool":"done","summary":"完整交付: 第一题 {答案A} 第二题 {答案B}"}\n\n以下是试卷正文（这段在 JSON 之后，应被丢弃）: 题目 {示例} 略',
    };
  }
  const hasOrder = allUserText.includes('确认订单');
  const hasResumeTest = allUserText.includes('步数续跑');
  if (hasResumeTest) {
    if (last.includes('用户要求继续')) {
      return { tool: 'done', summary: '续跑后完成' };
    }
    return { tool: 'scroll', direction: 'down' };
  }
  const hasSalvageTest = allUserText.includes('截断交付');
  if (hasSalvageTest) {
    return {
      __raw: '<think>Let me provide the final done action with the full quiz</think>\n{"tool":"done","summary":"第一题: 什么是 Agent 循环?\\n答案: 感知-决策-执行的迭代。\\n第二题: 为什么需要快照剪枝?\\n答案: 控制上下文长度,防止 （此处输出被长度截断',
    };
  }
  const hasSalvageGuard = allUserText.includes('截断他键');
  if (hasSalvageGuard) {
    return {
      __raw: '{"tool":"done","summary":"这是一个已经完整闭合的摘要内容,不应该被抢救","extra":"值写到一半被截断',
    };
  }
  const hasSearch = allUserText.includes('测试搜索站');
  const hasDropdown = allUserText.includes('下拉测试页');

  if (hasCanvas) {
    if (last.includes('已点击')) {
      return { tool: 'done', summary: '已通过坐标点击画布按钮' };
    }
    if (lastUser && hasImagePart(lastUser)) {
      return { tool: 'click_at', x: 0.5, y: 0.4 };
    }
    if (results === 0) return { tool: 'click', id: 99 };
    if (results === 1) return { tool: 'click', id: 98 };
    return { tool: 'done', summary: '已通过坐标点击画布按钮' };
  }

  if (hasDropdown) {
    if (results === 0) {
      const m = last.match(/^\[(\d+)\] input[^\n]*placeholder="请选择人员"/m);
      if (!m) return { tool: 'done', summary: '无法识别的场景' };
      return { tool: 'click', id: Number(m[1]) };
    }
    if (results === 1) {
      const m = last.match(/^\[(\d+)\] div role=option[^\n]*"李强"/m);
      if (!m) return { tool: 'done', summary: '无法识别的场景' };
      return { tool: 'click', id: Number(m[1]) };
    }
    return { tool: 'done', summary: '已选择李强' };
  }

  if (hasOrder && !hasSearch) {
    return buildOrderReply(last, results);
  }
  if (hasSearch) {
    return buildSearchReply(last, results);
  }

  return { tool: 'done', summary: '无法识别的场景' };
}

// --- Response writers ---

function writeJson(res, status, payload) {
  if (res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...CORS_HEADERS,
  });
  res.end(body);
}

function writeSse(res, contentString, usage) {
  if (res.destroyed) return;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    ...CORS_HEADERS,
  });
  // 内容块：choices 流式 delta；usage 段后到避免与正文顺序耦合。
  const chunk = { choices: [{ delta: { content: contentString } }] };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  if (usage) {
    // OpenAI 流式约定：最后一个 chunk 含空 choices + usage（与 stream_options.include_usage 配套）
    res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

// --- HTTP handler ---

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    writeJson(res, 200, { object: 'list', data: [] });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        writeJson(res, 400, { error: { message: 'invalid JSON body' } });
        return;
      }
      reqCount += 1;
            reqBytes.push(Buffer.byteLength(raw));
      const msgs = body && Array.isArray(body.messages) ? body.messages : [];
      if (!sawImage && msgs.some(hasImagePart)) sawImage = true;
      if (msgs.some((m) => m && m.role === 'system' && msgText(m).includes('已知事实'))) {
        sawMemoryInjection += 1;
      }
      const stream = body && body.stream === true;
      const taskM = msgText(msgs.find((m) => m && m.role === 'user') || '').match(/^任务: ([^\n]+)/m);
      const lastU = msgs.filter((m) => m && m.role === 'user').pop();
      const isDistill = lastU && msgText(lastU).includes('提取值得长期记住的信息');
      console.log(`[mock] req#${reqCount} ${Buffer.byteLength(raw)}B task=${taskM ? taskM[1] : '(none)'}${isDistill ? ' [distill]' : ''} users=${msgs.filter((m) => m && m.role === 'user').length}`);
      const action = decideAction(msgs);
      if (action && typeof action.__delay === 'number') {
        await new Promise((r) => setTimeout(r, action.__delay));
        if (res.destroyed) return;
      }
      const contentString = action && typeof action.__raw === 'string'
 ? action.__raw
 : JSON.stringify(action);
      if (stream) {
        // 与非流式 usage 计算口径一致——按请求体/响应体字节数估值，保证 e2e 中 token-usage 行数值稳定。
        const usage = {
          prompt_tokens: Math.ceil(raw.length / 4),
          completion_tokens: Math.ceil(contentString.length / 4),
        };
        writeSse(res, contentString, usage);
      } else {
        writeJson(res, 200, {
          choices: [{ message: { role: 'assistant', content: contentString } }],
          usage: {
            prompt_tokens: Math.ceil(raw.length / 4),
            completion_tokens: Math.ceil(contentString.length / 4),
          },
        });
      }
    });
    req.on('error', () => {});
    return;
  }

  // Jev mock：POST /v1/systemone。任务含「快路径测试」时按调用序分流
  // （与 buildSearchReply 的 results 计数同构）：第 1 次（输入步，需生成文本）
  // → _llm 回退大模型；第 2 次 → 选中快照里的「搜索」按钮（高置信直执，
  // 验证快路径绕过 LLM）；第 3 次起 → _llm（done 的 summary 只能大模型写）。
  if (req.method === 'POST' && url.pathname === '/v1/systemone') {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        writeJson(res, 400, { error: { message: 'invalid JSON body' } });
        return;
      }
      sawJev += 1;
      const state = body && body.state && typeof body.state === 'object' ? body.state : {};
      const task = typeof state.task === 'string' ? state.task : '';
      const snapshot = typeof state.snapshot === 'string' ? state.snapshot : '';
      let choice = '_llm';
      if (task.includes('快路径测试')) {
        sawJevSearch += 1;
        if (sawJevSearch === 2) {
          const m = snapshot.match(/\[(\d+)\] button[^\n]*"搜索"/);
          if (m) {
            choice = m[1];
            sawJevClick += 1;
          }
        }
      }
      writeJson(res, 200, {
        model: 'jev-mock',
        answers: {
          next: { type: 'choice', choice, probabilities: { [choice]: 0.9 }, confidence: 0.9 },
          task_done: { type: 'noul', noul: 0.05 },
        },
        usage: { prompt_tokens: Math.ceil(raw.length / 4), completion_tokens: 20 },
      });
    });
    req.on('error', () => {});
    return;
  }

  if (req.method === 'GET' && url.pathname === '/__stats') {
    writeJson(res, 200, { reqCount, sawImage, sawSteer, sawHistory, sawUpload, sawDialog, sawAutoAlert, sawDialogGuard, sawEntry, sawDistill, sawMemoryInjection, sawJev, sawJevClick, thinkOnlyServed, refusalServed, formatRecoveryServed, reqBytes });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...CORS_HEADERS });
  res.end('Not Found');
});

server.listen(PORT, HOST, () => {
  console.log(`mock-llm listening on ${PORT}`);
});