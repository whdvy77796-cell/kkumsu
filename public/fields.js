// 목록형 입력 칸 (메뉴·매입 품목·견적 등에서 공용)
import { h } from './ui.js';

export function parseNum(s) {
  const t = String(s ?? '').replace(/[,\s원]/g, '');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

export function fieldInput(f, row, onChange) {
  const lab = h('span', { class: 'lab' }, f.label, f.unit ? ` (${f.unit})` : '');
  let el;
  if (f.type === 'select') {
    el = h('select', { onchange: (e) => { row[f.key] = e.target.value; onChange(); } }, h('option', { value: '' }, f.emptyLabel || '선택'), f.options.filter(([v]) => v !== '').map(([v, l]) => h('option', { value: v }, l)));
    el.value = row[f.key] || '';
  } else if (f.type === 'check') {
    return h('label', { class: 'check-line' }, h('input', { type: 'checkbox', checked: !!row[f.key], onchange: (e) => { row[f.key] = e.target.checked; onChange(); } }), f.label);
  } else if (f.type === 'date') {
    el = h('input', { type: 'date', value: row[f.key] || '', onchange: (e) => { row[f.key] = e.target.value; onChange(); } });
  } else if (f.type === 'month') {
    el = h('input', { type: 'text', value: row[f.key] || '', placeholder: 'YYYY-MM (예: 2026-10)', oninput: (e) => { row[f.key] = e.target.value.trim(); onChange(); } });
  } else if (['number', 'won', 'man'].includes(f.type)) {
    const man = f.type === 'man';
    const cur = row[f.key];
    el = h('input', { type: 'text', inputmode: 'decimal', value: cur === '' || cur == null ? '' : String(man ? +cur / 10000 : cur), placeholder: f.placeholder || '', oninput: (e) => {
      const n = parseNum(e.target.value);
      row[f.key] = n === null || Number.isNaN(n) ? '' : man ? Math.round(n * 10000) : n;
      onChange();
    } });
  } else {
    el = h('input', { type: 'text', value: row[f.key] || '', placeholder: f.placeholder || '', oninput: (e) => { row[f.key] = e.target.value; onChange(); } });
  }
  return h('label', { class: 'field' }, lab, el);
}
