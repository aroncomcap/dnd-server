/**
 * game-utils.js
 * Extracted, testable functions from game.html
 * All functions are pure (accept params, return values instead of modifying globals)
 */

/**
 * Escape HTML special characters to prevent XSS
 * @param {string} str - String to escape
 * @returns {string} Escaped HTML-safe string
 */
export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render DM narration text with special formatting
 * Strips markdown noise, handles paragraph breaks, colors mechanic lines
 * @param {string} text - Raw DM narration text
 * @returns {string} HTML-safe formatted text with <br/> separators
 */
export function renderDmText(text) {
  if (!text || text === 'undefined' || typeof text !== 'string') return '';

  // Strip markdown noise before escaping
  let cleaned = text
    .replace(/^#{1,3}\s+.*$/gm, '')                    // strip ALL # headers
    .replace(/^-{3,}\s*$/gm, '')                       // --- dividers
    .replace(/\n{3,}/g, '\n\n')                        // collapse 3+ newlines to 2
    .replace(/\n\n/g, '⏎⏎')                           // preserve intentional paragraph breaks
    .replace(/\n/g, ' ')                               // join single newlines into flowing prose
    .replace(/⏎⏎/g, '\n\n')                           // restore paragraph breaks
    .replace(/  +/g, ' ')                              // collapse double spaces
    .trim();

  const escaped = cleaned
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const lines = escaped.split('\n');
  const result = [];
  let mechBuf = []; // buffer for consecutive mechanic lines

  function flushMech() {
    if (!mechBuf.length) return;
    const combined = mechBuf.join(' — ');
    // NPC speech: contains quotes
    if (/["\u201c\u201d]/.test(combined)) {
      result.push(`<span class="npc-speech">${combined}</span>`);
    } else {
      let color = '';
      if (/\bhit\b|success/i.test(combined)) color = 'color:#4a8';
      else if (/\bmiss\b|fail/i.test(combined)) color = 'color:#c44';
      result.push(`<span class="mechanic" style="${color}">${combined}</span>`);
    }
    mechBuf = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\*\*(.+)\*\*$/.test(trimmed)) {
      mechBuf.push(trimmed.slice(2, -2));
    } else {
      flushMech();
      // Inline bold quotes → npc-speech span
      const rendered = line
        .replace(/\*\*(&quot;.+?&quot;[^*]*)\*\*/g, '<span class="npc-speech">$1</span>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      result.push(rendered);
    }
  }
  flushMech();
  return result.join('<br/>');
}

/**
 * Build a DOM element for a chat message (pure version)
 * Returns the built element without modifying DOM
 * @param {string} type - Message type ('dm', 'player', 'system')
 * @param {string} text - Message text
 * @param {string} label - Speaker label (e.g., '🎲 Game Master')
 * @param {string} token - Optional character token image URL
 * @returns {Object} {type, text, label, token, html: HTMLElement}
 */
export function buildMsg(type, text, label = '', token = null) {
  const wrap = document.createElement('div');
  wrap.classList.add('msg', 'msg-' + type);

  if (type === 'player' && token) {
    const img = document.createElement('img');
    img.className = 'msg-token';
    img.src = token;
    wrap.appendChild(img);
  }

  if (label) {
    const lbl = document.createElement('div');
    lbl.className = 'msg-label';
    lbl.textContent = label;
    wrap.appendChild(lbl);
  }

  const body = document.createElement('div');
  if (type === 'dm') {
    body.innerHTML = renderDmText(text);
  } else {
    body.textContent = text;
  }
  wrap.appendChild(body);

  return { type, text, label, token, html: wrap };
}

/**
 * Render action options as DOM elements
 * Returns validated options and HTML structure without modifying DOM
 * @param {string[]} options - Array of option strings
 * @returns {Object} {options: string[], html: HTMLElement}
 */
export function buildOptionsPanel(options) {
  const area = document.createElement('div');
  area.id = 'options-area-temp';

  if (!options || !options.length) {
    return { options: [], html: area };
  }

  const lbl = document.createElement('div');
  lbl.className = 'options-label';
  lbl.textContent = 'Choose Your Action';
  area.appendChild(lbl);

  const validOptions = [];
  options.slice(0, 3).forEach(opt => {
    if (!opt || typeof opt !== 'string') return;
    const btn = document.createElement('button');
    btn.className = 'option-btn';
    const escaped = escapeHtml(opt);
    btn.innerHTML = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    area.appendChild(btn);
    validOptions.push(opt);
  });

  return { options: validOptions, html: area };
}

/**
 * Validate that a message object has required fields
 * @param {Object} msg - Message object to validate
 * @param {string} expectedType - Expected type ('dm_message', 'player_message', etc.)
 * @returns {Object} {valid: boolean, errors: string[]}
 */
export function validateSocketMessage(msg, expectedType) {
  const errors = [];

  if (!msg || typeof msg !== 'object') {
    errors.push('Message must be an object');
    return { valid: false, errors };
  }

  switch (expectedType) {
    case 'dm_message':
      if (typeof msg.text !== 'string' || msg.text.trim() === '') {
        errors.push('dm_message.text must be non-empty string');
      }
      if (!Array.isArray(msg.options)) {
        errors.push('dm_message.options must be an array');
      }
      if (typeof msg.forPlayer !== 'string') {
        errors.push('dm_message.forPlayer must be a string');
      }
      break;

    case 'player_message':
      if (typeof msg.player !== 'string' || msg.player.trim() === '') {
        errors.push('player_message.player must be non-empty string');
      }
      if (typeof msg.text !== 'string') {
        errors.push('player_message.text must be a string');
      }
      break;

    case 'turn_changed':
      if (typeof msg.currentPlayer !== 'string' || msg.currentPlayer.trim() === '') {
        errors.push('turn_changed.currentPlayer must be non-empty string');
      }
      break;

    case 'character_registered':
      if (typeof msg.name !== 'string' || msg.name.trim() === '') {
        errors.push('character_registered.name must be non-empty string');
      }
      if (!msg.character || typeof msg.character !== 'object') {
        errors.push('character_registered.character must be an object');
      }
      break;

    case 'dm_stream_end':
      if (typeof msg.narration !== 'string') {
        errors.push('dm_stream_end.narration must be a string');
      }
      break;
  }

  return { valid: errors.length === 0, errors };
}
