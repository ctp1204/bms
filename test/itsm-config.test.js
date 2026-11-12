'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const itsm = require(path.join(__dirname, '../config/itsm.json'));
const rules = require(path.join(__dirname, '../config/alarms.json'));

const priorities = Object.keys(itsm.priorities).filter(k => !k.startsWith('$'));

test('every alarm rule is mapped exactly once (ticket, note-only or ignored)', () => {
  const seen = [
    ...itsm.groups.flatMap(g => [...Object.keys(g.rules), ...(g.noteOnly || [])]),
    ...itsm.ignore,
  ];
  const dupes = seen.filter((id, i) => seen.indexOf(id) !== i);
  assert.deepEqual(dupes, [], `mapped more than once: ${dupes}`);
  assert.deepEqual([...seen].sort(), rules.map(r => r.id).sort());
});

test('info alarms never open a ticket', () => {
  const ticketRules = new Set(itsm.groups.flatMap(g => Object.keys(g.rules)));
  for (const r of rules.filter(x => x.severity === 'info')) {
    assert.ok(!ticketRules.has(r.id), `${r.id} is info but opens a ticket`);
  }
});

test('groups reference known teams, priorities and scopes; names are bilingual', () => {
  const ids = itsm.groups.map(g => g.id);
  assert.equal(new Set(ids).size, ids.length, 'group ids must be unique');
  for (const g of itsm.groups) {
    assert.ok(itsm.teams[g.team], `${g.id}: unknown team ${g.team}`);
    assert.ok(['site', 'device'].includes(g.scope), `${g.id}: bad scope ${g.scope}`);
    assert.ok(g.name.vi && g.name.ja, `${g.id}: name needs vi and ja`);
    for (const [rule, p] of Object.entries(g.rules)) assert.ok(priorities.includes(p), `${g.id}.${rule}: unknown priority ${p}`);
  }
  for (const t of Object.values(itsm.teams)) assert.ok(t.vi && t.ja);
});

test('SLA: higher priority means shorter response and resolution time', () => {
  const sla = priorities.sort().map(p => itsm.priorities[p]);
  for (let i = 1; i < sla.length; i++) {
    assert.ok(sla[i].ttoMin > sla[i - 1].ttoMin && sla[i].ttrMin > sla[i - 1].ttrMin, `P${i + 1} must be slower than P${i}`);
  }
});
