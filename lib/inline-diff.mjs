// Compare the complete original and verified revised text without storing the original.
// Token-level Hirschberg LCS uses linear memory, even for the 6,000-character input limit.
const tokens = value => String(value).match(/[\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}]/gu) || [];

export function changedRanges(original, revised) {
  if (typeof original !== 'string' || typeof revised !== 'string') return [];
  const a=tokens(original), b=tokens(revised), same=new Uint8Array(b.length);
  const row=(a0,a1,b0,b1,reverse=false)=>{
    const width=b1-b0; let prev=new Uint16Array(width+1),next=new Uint16Array(width+1);
    for(let ai=0;ai<a1-a0;ai++){
      const x=reverse?a[a1-1-ai]:a[a0+ai]; next[0]=0;
      for(let bj=1;bj<=width;bj++){
        const y=reverse?b[b1-bj]:b[b0+bj-1];
        next[bj]=x===y?prev[bj-1]+1:Math.max(prev[bj],next[bj-1]);
      }
      [prev,next]=[next,prev];
    }
    return prev;
  };
  const align=(a0,a1,b0,b1)=>{
    while(a0<a1&&b0<b1&&a[a0]===b[b0]){same[b0]=1;a0++;b0++;}
    while(a0<a1&&b0<b1&&a[a1-1]===b[b1-1]){same[b1-1]=1;a1--;b1--;}
    if(a0===a1||b0===b1)return;
    if(a1-a0===1){for(let j=b0;j<b1;j++)if(a[a0]===b[j]){same[j]=1;break;}return;}
    if(b1-b0===1){for(let i=a0;i<a1;i++)if(a[i]===b[b0]){same[b0]=1;break;}return;}
    const mid=a0+Math.floor((a1-a0)/2),width=b1-b0,left=row(a0,mid,b0,b1),right=row(mid,a1,b0,b1,true);
    let best=-1,cut=0;
    for(let j=0;j<=width;j++){const n=left[j]+right[width-j];if(n>best){best=n;cut=j;}}
    align(a0,mid,b0,b0+cut);align(mid,a1,b0+cut,b1);
  };
  align(0,a.length,0,b.length);
  const ranges=[];let position=0,open=-1;
  for(let i=0;i<b.length;i++){
    const length=Array.from(b[i]).length;
    if(!same[i]&&open<0)open=position;
    if(same[i]&&open>=0){ranges.push([open,position]);open=-1;}
    position+=length;
  }
  if(open>=0)ranges.push([open,position]);
  return ranges;
}

// Return only validated ranges within the disclosed prefix; no text is stored in marks.
export function clippedRanges(ranges, prefixLength, totalLength) {
  if(!Array.isArray(ranges)||!Number.isSafeInteger(prefixLength)||!Number.isSafeInteger(totalLength)||prefixLength<0||prefixLength>totalLength)return [];
  const out=[];let previous=0;
  for(const item of ranges){
    if(!Array.isArray(item)||item.length!==2||!Number.isSafeInteger(item[0])||!Number.isSafeInteger(item[1])||item[0]<previous||item[0]>=item[1]||item[1]>totalLength)return [];
    previous=item[1];
    if(item[0]<prefixLength)out.push([item[0],Math.min(item[1],prefixLength)]);
  }
  return out;
}
