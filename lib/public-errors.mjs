// Generation errors are an unpaid response. Never return model-authored prose here.
const questions=Object.freeze({
 relevance:'문항에서 묻는 상황을 보여주는 실제 경험을 하나 알려주세요.',
 specificity:'그 상황에서 본인이 직접 한 행동을 구체적으로 알려주세요.',
 agency:'함께한 일 중 본인이 맡아 직접 수행한 부분을 구분해주세요.',
 reasoning:'그 행동을 선택한 실제 이유나 판단 기준을 알려주세요.',
 roleFit:'확인한 경험이 지원 업무의 어떤 부분과 연결되는지 살펴봐 주세요.',
 repetition:'다른 문항과 구분되는 실제 장면이나 행동이 있는지 알려주세요.',
 cliches:'추상적인 설명 대신 당시에 실제로 했던 일을 짧게 알려주세요.',
 naturalness:'본인이 평소 사용하는 말로 당시 상황과 행동을 설명해주세요.'
});
const auditMessages=Object.freeze({
 unsupportedClaims:'선택한 사실로 확인되지 않은 주장이 남아 있어 결과를 공개하지 않았습니다.',
 excludedContent:'제외 요청과 맞지 않는 부분이 남아 있어 결과를 공개하지 않았습니다.',
 factConflicts:'원문 또는 사용자 정정 내용과 맞지 않는 부분이 남아 있습니다.'
});
const numberFields=['charLimit','minimum','targetMinimum','targetMaximum','actual'];
export function publicGenerationErrorDetails(details,data){
 if(!details||typeof details!=='object')return {};
 const out={};
 if(['draft','review'].includes(details.stage))out.stage=details.stage;
 for(const key of ['maxOutputTokens','completion_tokens','reasoning_tokens'])if(Number.isSafeInteger(details[key])&&details[key]>=0)out[key]=details[key];
 const prompts=Array.isArray(data?.profile?.prompts)?data.profile.prompts:[];
 if(Array.isArray(details.lengths))out.lengths=details.lengths.slice(0,5).filter(r=>r&&prompts.some(p=>p.id===r.id)).map(r=>{const v={id:r.id};for(const key of numberFields)if(Number.isSafeInteger(r[key])&&r[key]>=0)v[key]=r[key];return v;});
 if(details.audit&&typeof details.audit==='object'){
  out.audit={sufficient:details.audit.sufficient===true};
  for(const [key,message] of Object.entries(auditMessages))out.audit[key]=Array.isArray(details.audit[key])&&details.audit[key].length===0?[]:[message];
 }
 const issues=[];
 if(Array.isArray(details.quality?.issues))for(const issue of details.quality.issues){
  const index=prompts.findIndex(p=>p.id===issue?.promptId);
  if(index<0||!Object.hasOwn(questions,issue?.criterion))continue;
  if(issues.some(x=>x.promptId===issue.promptId&&x.criterion===issue.criterion))continue;
  issues.push({promptId:issue.promptId,criterion:issue.criterion,question:(index+1)+'번 문항: '+questions[issue.criterion]});
  if(issues.length===3)break;
 }
 if(details.quality&&typeof details.quality==='object')out.quality={repairAttempted:details.quality.repairAttempted===true,issues};
 if(issues.length)out.missing=issues.map(x=>x.question);
 else if((Array.isArray(details.missing)&&details.missing.length)||details.audit?.sufficient===false)out.missing=['사용하려는 경험에서 직접 한 행동과 실제로 확인한 결과를 보완해주세요. 없는 수치나 경험을 만들 필요는 없습니다.'];
 return out;
}
