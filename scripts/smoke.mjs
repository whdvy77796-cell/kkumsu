// 개발용 점검 스크립트: 예시 가게 2곳의 계산·진단 결과 요약을 출력
import { generateReport } from '../shared/diagnose.js';
import { sampleDeliveryRestaurant, sampleHallCafe } from '../shared/samples.js';
import { visibleQuestions, progress } from '../shared/engine.js';

for (const mk of [sampleDeliveryRestaurant, sampleHallCafe]) {
  const d = mk();
  const r = generateReport(d);
  const p = r.calc.profit;
  const pr = progress(d);
  console.log('==', r.store.name, '| 답변', pr.done, '/', pr.total);
  console.log('이익', p.kind, Math.round(p.low), Math.round(p.high), '누락', p.missing, '불명확', p.uncertain, '이미차감', p.deducted);
  console.log('시간당', r.calc.ownerHourly && Math.round(r.calc.ownerHourly.high), 'BEP', r.calc.bep && Math.round(r.calc.bep.sales), r.calc.bep && Math.round(r.calc.bep.salesWithOwner));
  console.log('메뉴원가율', r.calc.menu.theoreticalRate?.toFixed(3), '차이', r.calc.menu.gap?.toFixed(3));
  console.log('메뉴분류', JSON.stringify(Object.fromEntries(Object.entries(r.calc.menu.groups).map(([k, v]) => [k, v.map((i) => i.name)]))));
  console.log('배달1건', r.calc.deliveryUnit && Math.round(r.calc.deliveryUnit.left), r.calc.deliveryUnit && r.calc.deliveryUnit.rate.toFixed(3));
  console.log('매입비교', r.calc.purchase.rows.map((x) => x.item.name + ':' + x.comparisons.map((c) => c.level + '/' + (c.monthlySaving ? Math.round(c.monthlySaving) : '')).join(',')).join(' | '));
  console.log('해결책', r.solutions.map((s) => `${s.id}:${s.score}${s.usedAlt ? '(대안)' : ''}${s.feasibility === 1 ? '(제약)' : ''}`).join(' '));
  console.log('우선3', r.top.join(', '));
  console.log('핵심', r.keyFindings.join(' / '));
  console.log('재확인', visibleQuestions(d).filter((q) => q.type === 'check').map((q) => q.id).join(', '));
  console.log('이번주', r.plan.week.map((x) => x.text.slice(0, 28)).join(' / '), r.plan.weekHours);
  console.log('강점', r.strengths.length, '추가자료', r.needMore.length);
}
