import type { Page } from '@playwright/test';

export async function getCompletedDmMessageCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const isCompletedDmMessage = (msg: Element) => {
      if (msg.id === 'dm-stream-bubble' || msg.id === 'thinking-indicator') return false;
      if (msg.querySelector('#dm-stream-body') || msg.querySelector('#thinking-tip')) return false;
      const text = (msg.textContent || '').trim();
      return text.length > 0 && !text.includes('Thinking...');
    };

    return Array.from(document.querySelectorAll('#chat-log .msg-dm'))
      .filter(isCompletedDmMessage)
      .length;
  });
}

export async function getLastCompletedDmText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const isCompletedDmMessage = (msg: Element) => {
      if (msg.id === 'dm-stream-bubble' || msg.id === 'thinking-indicator') return false;
      if (msg.querySelector('#dm-stream-body') || msg.querySelector('#thinking-tip')) return false;
      const text = (msg.textContent || '').trim();
      return text.length > 0 && !text.includes('Thinking...');
    };

    const messages = Array.from(document.querySelectorAll('#chat-log .msg-dm'))
      .filter(isCompletedDmMessage);
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg) return '';

    const body = Array.from(lastMsg.querySelectorAll('div'))
      .filter(div => !div.classList.contains('msg-label'))
      .map(div => div.textContent || '')
      .join('\n')
      .trim();
    return body || (lastMsg.textContent || '').trim();
  });
}

export async function waitForActionResponse(page: Page, beforeCount: number, timeout = 45000): Promise<boolean> {
  return page.waitForFunction(
    (before) => {
      const isCompletedDmMessage = (msg: Element) => {
        if (msg.id === 'dm-stream-bubble' || msg.id === 'thinking-indicator') return false;
        if (msg.querySelector('#dm-stream-body') || msg.querySelector('#thinking-tip')) return false;
        const text = (msg.textContent || '').trim();
        return text.length > 0 && !text.includes('Thinking...');
      };
      const completedDmCount = Array.from(document.querySelectorAll('#chat-log .msg-dm'))
        .filter(isCompletedDmMessage)
        .length;

      return completedDmCount > before;
    },
    beforeCount,
    { timeout }
  ).then(() => true).catch(() => false);
}
