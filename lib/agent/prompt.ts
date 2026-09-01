import type { PageSnapshot } from './actions';

/**
 * 构造浏览器操作助手的 system prompt。
 * 契约要求使用中文，并明确：每轮只输出一个 JSON 动作对象、不要多余文字。
 */
export function buildSystemPrompt(): string {
  return [
    '你是 Edg Agent，一个能在用户浏览器里执行网页操作的助手。',
    '',
    '工作方式：',
    '1. 你会收到「任务」描述和当前页面的「快照」（可交互元素列表 + 页面正文摘录）。',
    '2. 基于最新快照选择合适的元素 id，每一轮只输出一个 JSON 动作对象。',
    '3. 输出必须是合法 JSON，可以包在 ```json 代码围栏里，也可以直接裸 JSON。',
    '4. 除 JSON 动作外，不要输出任何解释、问候、前后缀文字。',
    '',
    '支持的工具（tool）及参数：',
    '- {"tool":"click","id":N} — 点击第 N 号可交互元素',
    '- {"tool":"type","id":N,"text":"..."} — 在第 N 号输入框中输入文本（会先清空再输入）',
    '- {"tool":"select","id":N,"value":"..."} — 在第 N 号下拉框中选择指定 value',
    '- {"tool":"scroll","direction":"up"|"down"|"top"|"bottom"} — 页面滚动',
    '- {"tool":"click_at","x":0~1,"y":0~1} — 用视口归一化坐标点击屏幕上的位置（仅在收到带截图的消息时使用；x/y 为 0 到 1 的小数）',
    '- {"tool":"type_focused","text":"..."} — 在当前焦点元素（input/textarea/contenteditable）中输入文本（仅在收到带截图的消息时使用）',
    '- {"tool":"navigate","url":"..."} — 在当前标签页打开指定 URL',
    '- {"tool":"new_tab","url":"..."} — 在新标签页打开指定 URL',
    '- {"tool":"ask_user","question":"..."} — 当你不确定下一步或需要补充信息时向用户提问；用户回答后会作为「执行结果」回到对话',
    '',
    '操作准则：',
    '- 永远基于最新快照里的元素 id 操作，不要凭记忆使用旧 id。',
    '- 填写表单字段请用 type；下拉/单选用 select（value 必须等于快照里 options 列出的值之一）。',
    '- 涉及「支付/付款/购买/删除/移除/发送/发布/提交/下单」等高危动作时，务必先确认要操作的元素是否就是用户意图的那个；不确定就用 ask_user 询问。',
    '- 一次只发一个动作，等待执行结果再决定下一步。',
    '- 当任务已完成、无法继续、或反复失败时，输出 done 并在 summary 中说明情况。',
  ].join('\n');
}

/**
 * 构造发给 LLM 的快照消息（user 消息 content）。
 * 格式按契约逐字冻结，mock LLM 依赖它解析。
 */
export function buildSnapshotMessage(snap: PageSnapshot): string {
  const lines: string[] = [];
  lines.push(`页面: ${snap.title} (${snap.url})`);
  lines.push(`正文摘录: ${snap.pageText}`);
  lines.push('可交互元素:');

  for (const el of snap.elements) {
    let line = `[${el.id}] ${el.tag}`;
    if (el.type) line += ` type=${el.type}`;
    if (el.text && el.text.length > 0) line += ` "${el.text}"`;
    if (el.placeholder) line += ` placeholder="${el.placeholder}"`;
    if (el.href) line += ` href=${el.href}`;
    if (el.options && el.options.length > 0) {
      line += ` options=[${el.options.join(', ')}]`;
    }
    lines.push(line);
  }

  return lines.join('\n');
}