// Only the protected, payment-disabled operator testing deployment may repeat.
// Production, other Preview branches, different hosts and live/test payments stay unchanged.
export function previewRepeat(c){
 const e=c?.env||{};
 return e.VERCEL==='1'&&e.VERCEL_ENV==='preview'&&
  e.VERCEL_GIT_PROVIDER==='github'&&e.VERCEL_GIT_REPO_OWNER==='whdvy77796-cell'&&e.VERCEL_GIT_REPO_SLUG==='kkumsu'&&
  e.VERCEL_GIT_COMMIT_REF==='insosoe-staged-safety-20261107'&&c.origin==='https://kkumsu-git-insosoe-staged-safety-20261107-kkkkkum.vercel.app'&&
  (e.PAYMENT_MODE===undefined||e.PAYMENT_MODE===''||e.PAYMENT_MODE==='disabled');
}
