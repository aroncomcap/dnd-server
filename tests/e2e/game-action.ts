import type { Page } from '@playwright/test';

export async function getCompletedDmMessageCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('#chat-log .msg-dm'))
      .filter(msg => msg.id !== 'dm-stream-bubble' && msg.id !== 'thinking-indicator' && !msg.querySelector('#dm-stream-body'))
      .length;
  });
}

export async function waitForActionResponse(page: Page, beforeCount: number, timeout = 30000): Promise<boolean> {
  return page.waitForFunction(
    (before) => {
      const thinking = document.getElementById('thinking-indicator');
      const streamBody = document.getElementById('dm-stream-body');
      const sendBtn = document.getElementById('btn-send') as HTMLButtonElement | null;
      const completedDmCount = Array.from(document.querySelectorAll('#chat-log .msg-dm'))
        .filter(msg => msg.id !== 'dm-stream-bubble' && msg.id !== 'thinking-indicator' && !msg.querySelector('#dm-stream-body'))
        .length;

      return completedDmCount > before || (!!sendBtn && !sendBtn.disabled && !thinking && !streamBody);
    },
    beforeCount,
    { timeout }
  ).then(() => true).catch(() => false);
}
