import test from 'node:test';
import assert from 'node:assert/strict';
import { validateContract, attributionAssertions } from '../src/contract.mjs';
test('contracts reject typos, executable selectors and invalid field paths', () => {
  for (const value of [null, [], { pageVeiwEvent: 'x' }, { applicationEvents: [] }, { applicationEvents: [''] }, { consent: { acceptButton: '' } }, { attribution: { storageKey: 'x', firstTouchPath: '__proto__.x', lastTouchPath: 'x' } }, { collectors: [{ path: '//evil.test', eventField: 'event' }] }]) assert.throws(() => validateContract(value));
  assert.deepEqual(validateContract({}), {});
  assert.ok(validateContract({ attribution: { storageKey: 'my-project:attribution', firstTouchPath: 'first.source', lastTouchPath: 'last.source' } }));
});
test('attribution cannot pass on absent or identical test sources', () => {
  assert.deepEqual(attributionAssertions(null, null, '', ''), { firstTouchPreserved: false, lastTouchUpdated: false });
  assert.equal(attributionAssertions({ first: 'a', last: 'a' }, { first: 'a', last: 'a' }, 'a', 'a').lastTouchUpdated, false);
  assert.deepEqual(attributionAssertions({ first: 'a', last: 'a' }, { first: 'a', last: 'b' }, 'a', 'b'), { firstTouchPreserved: true, lastTouchUpdated: true });
});
