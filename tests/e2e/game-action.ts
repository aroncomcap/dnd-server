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

export async function getActionResponseDiagnostics(page: Page, beforeCount: number): Promise<string> {
  return page.evaluate((before) => {
    const isCompletedDmMessage = (msg: Element) => {
      if (msg.id === 'dm-stream-bubble' || msg.id === 'thinking-indicator') return false;
      if (msg.querySelector('#dm-stream-body') || msg.querySelector('#thinking-tip')) return false;
      const text = (msg.textContent || '').trim();
      return text.length > 0 && !text.includes('Thinking...');
    };

    const completedMessages = Array.from(document.querySelectorAll('#chat-log .msg-dm'))
      .filter(isCompletedDmMessage);
    const streamBody = document.querySelector('#dm-stream-body');
    const thinking = document.querySelector('#thinking-indicator, #thinking-tip');
    const sendButton = document.querySelector('#btn-send') as HTMLButtonElement | null;
    const lastCompleted = completedMessages[completedMessages.length - 1];
    const lastText = (lastCompleted?.textContent || '').replace(/\s+/g, ' ').trim();

    return [
      `url=${window.location.href}`,
      `completed_dm=${completedMessages.length}`,
      `completed_dm_before_action=${before}`,
      `streaming=${Boolean(streamBody)}`,
      `thinking=${Boolean(thinking)}`,
      `send_disabled=${sendButton ? sendButton.disabled : 'missing'}`,
      `send_text=${sendButton ? sendButton.textContent?.trim() : 'missing'}`,
      `last_dm=${lastText.slice(-400)}`,
    ].join('\n');
  }, beforeCount).catch(err => `diagnostics_unavailable=${err.message}`);
}
