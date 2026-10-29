// Utilitários de telefone (Brasil). Sem dependências.

export const digits = (v) => String(v ?? '').replace(/\D/g, '');

/** Número pronto pra envio no WhatsApp (DDI+DDD+número) ou null se inválido. */
export function toWaNumber(raw) {
  let d = digits(raw).replace(/^0+/, '');
  if (!d) return null;
  if (d.length <= 11) d = '55' + d; // mesma regra do sistema: sem DDI → assume Brasil
  return d.length >= 12 && d.length <= 15 ? d : null;
}

/**
 * Chave de comparação entre números: DDD + últimos 8 dígitos.
 * Ignora DDI (55) e o "9" extra, porque o WhatsApp às vezes devolve o número
 * brasileiro com ou sem o nono dígito.
 */
export function phoneKey(raw) {
  let d = digits(raw);
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
  if (d.length >= 10) return d.slice(0, 2) + d.slice(-8);
  return d.length >= 8 ? d.slice(-8) : null;
}

/** "5511999990000:12@s.whatsapp.net" → "5511999990000" (só pra JIDs de telefone). */
export function jidToPhone(jid) {
  if (!jid || !String(jid).endsWith('@s.whatsapp.net')) return null;
  return String(jid).split('@')[0].split(':')[0] || null;
}
