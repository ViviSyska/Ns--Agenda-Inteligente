// Interpreta a resposta da cliente ao lembrete: 'confirmou' | 'recusou' | null.

const GREETINGS = /^(oi+|ola|opa|e ai|bom dia|boa tarde|boa noite|tudo bem|tudo bom|oie)( |$)/;

const NEGATIVE_START = /^(nao|n|2|no|nope|negativo|cancela|cancelar|cancelado|desmarca|desmarcar|infelizmente|nao vou|nao posso|nao consigo)( |$)/;
const NEGATIVE_ANY = /\b(cancel\w*|desmarc\w*|nao vou|nao poderei|nao consigo ir|nao vai dar|nao da pra)\b/;
const POSITIVE_START = /^(sim|s|1|yes|ok|okay|confirmo|confirmado|confirmada|claro|pode|pode ser|combinado|certo|beleza|blz|vou|vou sim|estarei la|estarei|presenca confirmada|com certeza|positivo)( |$)/;

export function parseReply(raw) {
  const original = String(raw ?? '').trim();
  if (!original) return null;

  // Emojis sozinhos
  if (/^[\s👍✅✔👌🙏]+$/u.test(original)) return 'confirmou';
  if (/^[\s👎❌✖🚫]+$/u.test(original)) return 'recusou';

  let t = original
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;

  // tira saudações do começo ("oi, boa noite, sim confirmo")
  for (let i = 0; i < 3; i++) {
    const m = t.match(GREETINGS);
    if (!m) break;
    t = t.slice(m[0].length).trim();
  }
  if (!t) return null;

  if (NEGATIVE_START.test(t) || NEGATIVE_ANY.test(t)) return 'recusou';
  if (POSITIVE_START.test(t)) return 'confirmou';
  return null;
}

/** Texto de uma mensagem do Baileys (conversa, resposta, botão, lista...). */
export function extractText(message) {
  if (!message) return '';
  const m = message.ephemeralMessage?.message || message.viewOnceMessage?.message || message;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    ''
  );
}

/** Texto para exibir no chat: o próprio texto, ou um rótulo para mídia. null = ignorar (reação, protocolo...). */
export function describeMessage(message) {
  if (!message) return null;
  const m = message.ephemeralMessage?.message || message.viewOnceMessage?.message || message.viewOnceMessageV2?.message || message;
  const t = extractText(m);
  if (t) return t;
  if (m.imageMessage) return m.imageMessage.caption ? `📷 ${m.imageMessage.caption}` : '📷 Foto';
  if (m.videoMessage) return m.videoMessage.caption ? `🎥 ${m.videoMessage.caption}` : '🎥 Vídeo';
  if (m.audioMessage) return '🎤 Áudio';
  if (m.documentMessage) return `📄 ${m.documentMessage.fileName || 'Documento'}`;
  if (m.stickerMessage) return '🏷️ Figurinha';
  if (m.locationMessage) return '📍 Localização';
  if (m.contactMessage || m.contactsArrayMessage) return '👤 Contato';
  return null;
}
