// 계정 편집 화면에서 해시 이동을 취소할 때 기존 화면·입력을 다시 그리지 않는다.
export function allowOwnerHashChange(event, accountUI, browserHistory) {
  if (!accountUI.isEditingDirty() || accountUI.confirmLeave()) return true;
  try { browserHistory.replaceState(browserHistory.state, '', event.oldURL); } catch { /* 기존 화면은 그대로 둔다 */ }
  return false;
}
