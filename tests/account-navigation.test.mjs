import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowOwnerHashChange } from '../public/account-navigation.js';

const event = { oldURL: 'https://www.kkumsu.com/#/my-stores/abcdefghijklmnopqrstuv', newURL: 'https://www.kkumsu.com/#/' };
function history() { const calls=[]; return { state:{x:1}, calls, replaceState(...x) { calls.push(x); } }; }
test('navigation without unsaved changes proceeds without asking', () => {
  const h=history(), a={isEditingDirty:()=>false,confirmLeave:()=>{throw Error('must not ask')}};
  assert.equal(allowOwnerHashChange(event,a,h),true); assert.equal(h.calls.length,0);
});
test('canceling navigation restores old URL and keeps current screen', () => {
  const h=history(), a={isEditingDirty:()=>true,confirmLeave:()=>false};
  assert.equal(allowOwnerHashChange(event,a,h),false);
  assert.deepEqual(h.calls,[[h.state,'',event.oldURL]]);
});
test('confirming navigation proceeds without rewriting history', () => {
  const h=history(), a={isEditingDirty:()=>true,confirmLeave:()=>true};
  assert.equal(allowOwnerHashChange(event,a,h),true); assert.equal(h.calls.length,0);
});
test('failed history replacement does not render away unsaved data', () => {
  const h={state:null,replaceState(){throw Error('blocked')}},a={isEditingDirty:()=>true,confirmLeave:()=>false};
  assert.equal(allowOwnerHashChange(event,a,h),false);
});
