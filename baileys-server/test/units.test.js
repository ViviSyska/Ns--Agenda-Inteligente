import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReply, extractText } from '../src/reply-parser.js';
import { phoneKey, toWaNumber, jidToPhone } from '../src/phone.js';

test('parseReply: confirmações', () => {
  for (const t of ['Sim', 'sim!', 'SIM, confirmo', 's', '1', 'Confirmo', 'ok', 'Ok obrigada', 'Claro!', 'pode ser',
    'Oi, boa noite! Sim confirmo', 'Bom dia sim', 'vou sim', '👍', '✅', 'Combinado 😊', 'estarei lá']) {
    assert.equal(parseReply(t), 'confirmou', t);
  }
});

test('parseReply: recusas', () => {
  for (const t of ['Não', 'nao', 'NÃO!', 'n', '2', 'Não vou conseguir', 'não posso', 'preciso cancelar', 'quero desmarcar',
    'Oi boa tarde, não vou poder ir', '👎', '❌', 'Infelizmente não']) {
    assert.equal(parseReply(t), 'recusou', t);
  }
});

test('parseReply: conversa comum não vira resposta', () => {
  for (const t of ['', '   ', 'Qual o valor da depilação?', 'obrigada', 'Que horas abre?', 'Bom dia!', 'Oi', 'tudo bem?', 'Pode me mandar o endereço?']) {
    assert.equal(parseReply(t), t === 'Pode me mandar o endereço?' ? 'confirmou' : null, `"${t}"`);
  }
});

test('extractText: tipos de mensagem', () => {
  assert.equal(extractText({ conversation: 'Sim' }), 'Sim');
  assert.equal(extractText({ extendedTextMessage: { text: 'Não' } }), 'Não');
  assert.equal(extractText({ ephemeralMessage: { message: { conversation: 'ok' } } }), 'ok');
  assert.equal(extractText({ buttonsResponseMessage: { selectedDisplayText: 'Sim' } }), 'Sim');
  assert.equal(extractText({ imageMessage: {} }), '');
  assert.equal(extractText(null), '');
});

test('toWaNumber', () => {
  assert.equal(toWaNumber('(11) 99999-0000'), '5511999990000');
  assert.equal(toWaNumber('5511999990000'), '5511999990000');
  assert.equal(toWaNumber('+55 11 99999-0000'), '5511999990000');
  assert.equal(toWaNumber('11 3333-4444'), '551133334444');
  assert.equal(toWaNumber('99999-0000'), null); // sem DDD
  assert.equal(toWaNumber(''), null);
  assert.equal(toWaNumber(null), null);
});

test('phoneKey ignora DDI e nono dígito', () => {
  const k = phoneKey('(11) 99999-0000');
  assert.equal(k, '1199990000');
  assert.equal(phoneKey('5511999990000'), k);
  assert.equal(phoneKey('+55 11 9999-0000'), k); // sem o nono dígito
  assert.notEqual(phoneKey('5521999990000'), k); // DDD diferente
  assert.equal(phoneKey('55991234567'), '5591234567'); // DDD 55 (RS) sem DDI não pode ser confundido com o DDI
  assert.equal(phoneKey('abc'), null);
});

test('jidToPhone', () => {
  assert.equal(jidToPhone('5511999990000@s.whatsapp.net'), '5511999990000');
  assert.equal(jidToPhone('5511999990000:7@s.whatsapp.net'), '5511999990000');
  assert.equal(jidToPhone('123456789@lid'), null);
  assert.equal(jidToPhone(undefined), null);
});
