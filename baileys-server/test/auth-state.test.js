import test from 'node:test';
import assert from 'node:assert/strict';
import { useSupabaseAuthState } from '../src/supabase-auth-state.js';

// Mini-Supabase em memória, só com o que o auth state usa.
function fakeSb() {
  const rows = new Map(); // `${session}|${id}` -> { session, id, data, updated_at }
  const builder = (table) => {
    assert.equal(table, 'wa_auth');
    const q = { op: 'select', filters: [], rows: null, cols: null };
    const run = () => {
      const match = (r) => q.filters.every(([k, v, isIn]) => (isIn ? v.includes(r[k]) : r[k] === v));
      if (q.op === 'upsert') { for (const r of q.rows) rows.set(`${r.session}|${r.id}`, JSON.parse(JSON.stringify(r))); return { data: null, error: null }; }
      if (q.op === 'delete') { for (const [k, r] of [...rows]) if (match(r)) rows.delete(k); return { data: null, error: null }; }
      return { data: [...rows.values()].filter(match).map((r) => JSON.parse(JSON.stringify(r))), error: null };
    };
    const api = {
      select(cols) { q.cols = cols; return api; },
      upsert(r) { q.op = 'upsert'; q.rows = r; return Promise.resolve(run()); },
      delete() { q.op = 'delete'; return api; },
      eq(k, v) { q.filters.push([k, v, false]); return api; },
      in(k, v) { q.filters.push([k, v, true]); return api; },
      maybeSingle() { const r = run(); return Promise.resolve({ data: r.data[0] ?? null, error: null }); },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return api;
  };
  return { from: builder, rows };
}

test('sessão é gravada e recarregada com Buffers intactos', async () => {
  const sb = fakeSb();
  const a = await useSupabaseAuthState(sb, 'salao');
  assert.ok(a.state.creds.noiseKey, 'creds iniciais criadas');
  await a.saveCreds();

  await a.state.keys.set({
    'pre-key': { 1: { private: Buffer.from([1, 2, 3]), public: Buffer.from([4, 5, 6]) }, 2: { private: Buffer.from([7]), public: Buffer.from([8]) } },
    session: { 'abc.0': Buffer.from('sessao-signal') },
  });

  // "reinício do servidor": novo auth state lendo do banco
  const b = await useSupabaseAuthState(sb, 'salao');
  assert.deepEqual(Buffer.from(b.state.creds.noiseKey.private), Buffer.from(a.state.creds.noiseKey.private));
  assert.equal(b.state.creds.registrationId, a.state.creds.registrationId);

  const got = await b.state.keys.get('pre-key', ['1', '2', '3']);
  assert.ok(Buffer.isBuffer(got['1'].private));
  assert.deepEqual([...got['1'].private], [1, 2, 3]);
  assert.deepEqual([...got['2'].public], [8]);
  assert.equal(got['3'], null);

  const sess = await b.state.keys.get('session', ['abc.0']);
  assert.equal(Buffer.from(sess['abc.0']).toString(), 'sessao-signal');
});

test('remover chave (valor null) apaga do banco; sessões ficam isoladas', async () => {
  const sb = fakeSb();
  const a = await useSupabaseAuthState(sb, 'salao');
  const other = await useSupabaseAuthState(sb, 'outra');
  await a.state.keys.set({ 'pre-key': { 9: { private: Buffer.from([1]), public: Buffer.from([2]) } } });
  await other.state.keys.set({ 'pre-key': { 9: { private: Buffer.from([3]), public: Buffer.from([4]) } } });

  await a.state.keys.set({ 'pre-key': { 9: null } });
  assert.equal((await a.state.keys.get('pre-key', ['9']))['9'], null);
  assert.deepEqual([...(await other.state.keys.get('pre-key', ['9']))['9'].private], [3]);
});

test('clear() apaga só a sessão pedida', async () => {
  const sb = fakeSb();
  const a = await useSupabaseAuthState(sb, 'salao');
  const other = await useSupabaseAuthState(sb, 'outra');
  await a.saveCreds(); await other.saveCreds();
  await a.clear();
  assert.equal([...sb.rows.values()].filter((r) => r.session === 'salao').length, 0);
  assert.equal([...sb.rows.values()].filter((r) => r.session === 'outra').length, 1);
});
