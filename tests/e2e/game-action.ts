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

    const clone = lastMsg.cloneNode(true) as Element;
    clone.querySelectorAll('.msg-label, .narration-feedback').forEach(el => el.remove());
    const body = (clone.textContent || '').trim();
    return body || (lastMsg.textContent || '').trim();
  });
}

export async function waitForActionResponse(page: Page, beforeCount: number, timeout = Number(process.env.CAMPAIGN_RESPONSE_TIMEOUT_MS || 90000)): Promise<boolean> {
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

export async function isActionResponsePending(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const sendButton = document.querySelector('#btn-send') as HTMLButtonElement | null;
    const sendText = sendButton?.textContent?.trim().toLowerCase() || '';
    const sendBusy = Boolean(sendButton?.disabled && /sending|\.\.\.|⏳/.test(sendText));

    return Boolean((window as any)._actionInFlight) && (
      Boolean(document.querySelector('#dm-stream-body')) ||
      Boolean(document.querySelector('#thinking-indicator, #thinking-tip')) ||
      sendBusy
    );
  }).catch(() => false);
}

export async function waitForPendingActionToSettle(
  page: Page,
  beforeCount: number,
  timeout = Number(process.env.CAMPAIGN_RESPONSE_TIMEOUT_MS || 90000)
): Promise<'response' | 'settled' | 'timeout'> {
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
      if (completedDmCount > before) return 'response';

      const sendButton = document.querySelector('#btn-send') as HTMLButtonElement | null;
      const sendText = sendButton?.textContent?.trim().toLowerCase() || '';
      const sendBusy = Boolean(sendButton?.disabled && /sending|\.\.\.|⏳/.test(sendText));
      const actionPending = Boolean((window as any)._actionInFlight) && (
        Boolean(document.querySelector('#dm-stream-body')) ||
        Boolean(document.querySelector('#thinking-indicator, #thinking-tip')) ||
        sendBusy
      );

      return actionPending ? false : 'settled';
    },
    beforeCount,
    { timeout }
  ).then(result => result.jsonValue() as Promise<'response' | 'settled'>).catch(() => 'timeout');
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
    const turnBanner = document.querySelector('#turn-banner');
    const lastCompleted = completedMessages[completedMessages.length - 1];
    const lastClone = lastCompleted?.cloneNode(true) as Element | undefined;
    lastClone?.querySelectorAll('.msg-label, .narration-feedback').forEach(el => el.remove());
    const lastText = (lastClone?.textContent || lastCompleted?.textContent || '').replace(/\s+/g, ' ').trim();
    const actionInFlight = Boolean((window as any)._actionInFlight);

    return [
      `url=${window.location.href}`,
      `completed_dm=${completedMessages.length}`,
      `completed_dm_before_action=${before}`,
      `streaming=${Boolean(streamBody)}`,
      `thinking=${Boolean(thinking)}`,
      `action_in_flight=${actionInFlight}`,
      `send_disabled=${sendButton ? sendButton.disabled : 'missing'}`,
      `send_text=${sendButton ? sendButton.textContent?.trim() : 'missing'}`,
      `turn=${turnBanner ? turnBanner.textContent?.replace(/\s+/g, ' ').trim() : 'missing'}`,
      `last_dm=${lastText.slice(-400)}`,
    ].join('\n');
  }, beforeCount).catch(err => `diagnostics_unavailable=${err.message}`);
}
