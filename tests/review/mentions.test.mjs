import test from 'node:test';
import assert from 'node:assert/strict';
import {parseGitHubPayload} from '../../src/lib/github-payload.ts';
import {decideIngress} from '../../src/lib/ingress.ts';
import {DEFAULT_SETTINGS} from '../../src/lib/types.ts';
import {llmWorkAllowed, opsCommentAllowed} from '../../src/lib/ops-comment.ts';

const target = {owner:'fixture',repo:'fixture',pr:1957,title:'Draft review',headSha:'abc123',baseSha:'def456',sender:'author',isFork:false,isDraft:true};
const settings = {...DEFAULT_SETTINGS, skipDrafts:true, skipForks:true};
const decide = (patch={}) => decideIngress({hmacOk:true,settings,sample:target,trigger:'issue_comment.mention',deliveryId:'delivery',existing:[],thread:{kind:'mention',commentId:42,userText:'@ashlar-bot review'},...patch});
function payload(action='opened', body='@ashlar-bot review', extra={}) {
  return {action,installation:{id:1},repository:{full_name:'fixture/fixture'},sender:{login:'editor'},
    pull_request:{number:1957,title:'Draft review',body,draft:true,head:{sha:'abc123',repo:{fork:false}},base:{sha:'def456'},user:{login:'author'}},...extra};
}
function parse(action, body, extra, config=settings) {
  return parseGitHubPayload('pull_request',payload(action,body,extra),config);
}
function fromParsed(parsed, patch={}) {
  assert.equal(parsed.ok,true); assert.equal(parsed.kind,'review');
  return decide({trigger:parsed.trigger,sample:parsed.target,thread:parsed.thread,...patch});
}

test('explicit issue-comment request can review a draft without disabling skipDrafts',()=>{
  assert.ok(decide().job);
});
test('explicit inline follow-up can review a draft too',()=>{
  assert.ok(decide({trigger:'pull_request_review_comment.followup',thread:{kind:'followup',commentId:42,userText:'/review'}}).job);
});
test('draft and fork protections still apply without explicit authorization',()=>{
  assert.equal(decide({trigger:'pull_request.opened',thread:undefined}).skip,'draft');
  assert.equal(decide({thread:{kind:'mention',commentId:42,userText:'looks fine'}}).job,undefined);
  assert.match(decide({sample:{...target,isFork:true}}).skip,/fork/);
});
test('bad HMAC or duplicate delivery cannot be overridden by a draft mention',()=>{
  assert.equal(decide({hmacOk:false}).ok,false);
  assert.match(decide({knownDeliveries:['delivery']}).skip,/duplicate delivery_id/);
});
test('PR opened with body mention is a distinct explicit request, not an automatic PR review',()=>{
  const p=parse('opened','Description\n@ashlar-bot review');
  assert.equal(p.trigger,'pull_request.body_mention');
  assert.equal(p.thread.kind,'pr_body'); assert.equal(p.thread.commentId,0);
  assert.equal(p.target.sender,'editor');
  assert.equal(fromParsed(p).job?.isDraft,true);
  assert.equal(llmWorkAllowed(p),true); assert.equal(opsCommentAllowed(p),true);
});
test('mentions after the old 2000/4000 character preview boundary are still recognized',()=>{
  const text='Description '.repeat(700)+'\n@ashlar-bot review';
  const p=parse('opened',text);
  assert.equal(p.trigger,'pull_request.body_mention');
  assert.ok(fromParsed(p).job); assert.equal(p.thread.userText,text);
});
test('PR body recognizes configured username and configured slash commands',()=>{
  const custom={...settings,username:'review-team',mention:['/inspect']};
  for (const text of ['@review-team review','/inspect']) {
    const p=parse('opened',text,{},custom);
    assert.equal(p.trigger,'pull_request.body_mention');
    assert.ok(fromParsed(p,{settings:custom}).job);
  }
});
test('PR body lookalikes and ordinary descriptions never authorize model work',()=>{
  for (const text of ['@ashlar-botanist review','/reviews','no review requested']) {
    const p=parse('opened',text);
    assert.equal(p.trigger,'pull_request.opened'); assert.equal(p.thread,undefined);
    assert.equal(fromParsed(p).job,undefined);
  }
});
test('editing the body to add a mention triggers one explicit request',()=>{
  const p=parse('edited','Context\n@ashlar-bot review',{changes:{body:{from:'Context'}}});
  assert.equal(p.trigger,'pull_request.body_mention'); assert.ok(fromParsed(p).job);
  assert.match(fromParsed(p,{knownDeliveries:['delivery']}).skip,/duplicate delivery_id/);
});
test('adding a mention to a previously null body works',()=>{
  assert.ok(fromParsed(parse('edited','@ashlar-bot review',{changes:{body:{from:null}}})).job);
});
test('retained mention or title/base-only edits do not replay an earlier request',()=>{
  for (const extra of [{changes:{body:{from:'@ashlar-bot review'}}},{changes:{title:{from:'Old title'}}},{}]) {
    assert.equal(parse('edited','Updated text\n@ashlar-bot review',extra).kind,'ignore');
  }
});
test('removing a mention or editing unrelated text does not start review',()=>{
  assert.equal(parse('edited','Description only',{changes:{body:{from:'@ashlar-bot review'}}}).kind,'ignore');
  assert.equal(parse('edited','Other text',{changes:{body:{from:'Description'}}}).kind,'ignore');
});
test('synchronize/reopened/ready_for_review with a retained body mention do not trigger extra model calls',()=>{
  for (const action of ['synchronize','reopened','ready_for_review']) {
    const p=parse(action,'@ashlar-bot review');
    assert.equal(p.trigger,`pull_request.${action}`);
    assert.equal(fromParsed(p).job,undefined);
  }
});
test('a forged body trigger without an actual mention cannot bypass ingress',()=>{
  assert.equal(decide({trigger:'pull_request.body_mention',thread:{kind:'pr_body',commentId:0,userText:'ordinary description'}}).job,undefined);
});
test('a body mention does not bypass fork policy or HMAC validation',()=>{
  const p=parse('opened','@ashlar-bot review');
  assert.match(fromParsed(p,{sample:{...p.target,isFork:true}}).skip,/fork/);
  assert.equal(fromParsed(p,{hmacOk:false}).ok,false);
});

test('an explicit request starts a fresh job even after every terminal outcome at the same head',()=>{
  for (const status of ['posted','skipped','dlq','cancelled']) {
    const existing=[{...target,id:'old',deliveryId:'previous',trigger:'issue_comment.mention',status}];
    assert.ok(decide({existing}).job,status);
  }
});
test('PR body mention added while closed or merged is still an explicit request',()=>{
  for (const state of [{state:'closed',merged:false},{state:'closed',merged:true}]) {
    const raw=payload('edited','@ashlar-bot review',{changes:{body:{from:'Description'}}});
    Object.assign(raw.pull_request,state);
    const parsed=parseGitHubPayload('pull_request',raw,settings);
    assert.equal(parsed.trigger,'pull_request.body_mention');assert.ok(fromParsed(parsed).job);
  }
});
test('new explicit inline mentions are also recognized in edited review comments',()=>{
  const raw=payload('edited','Description',{comment:{id:43,body:'@ashlar-bot review'},changes:{body:{from:'A question'}}});
  const parsed=parseGitHubPayload('pull_request_review_comment',raw,settings);
  assert.equal(parsed.trigger,'pull_request_review_comment.followup');assert.ok(fromParsed(parsed).job);
});
