import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const source=readFileSync(new URL('../src/services/arb.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {screen,quoteExpired}=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const now=1_800_000_000_000;
const trip=(sellUsdc,notionalUsdc=100)=>({notionalUsdc,buyTokens:.3,sellUsdc,quotedPnlUsdc:sellUsdc-notionalUsdc,quotedPnlPct:(sellUsdc/notionalUsdc-1)*100,buyRoute:[],sellRoute:[],buyQuotedAt:now,sellQuotedAt:now,quotedAt:now});

test('round-trip loss is returned minus starting USDC, independent of pool gaps',()=>{
 const result=screen(trip(98.5),now);
 assert.equal(result.status,'negative');assert.equal(result.quotedPnlUsdc,-1.5);assert.equal(result.quotedPnlPct,-1.5);
 assert.equal(result.stressedPnlUsdc,-2.52);
});
test('positive quotes are preserved and remain unverified, even when stress erases the gain',()=>{
 const result=screen(trip(100.5),now);
 assert.equal(result.status,'positive-unverified');assert.equal(result.quotedPnlUsdc,.5);assert.equal(result.stressedPnlUsdc,-.52);
});
test('stress is 1% of actual starting amount plus a fixed .02 USDC allowance',()=>{
 const result=screen(trip(202,200),now);
 assert.equal(result.quotedPnlPct,1);assert.equal(result.stressUsdc,2);assert.equal(result.networkUsdc,.02);assert.equal(result.stressedPnlUsdc,-.02);
});
test('zero quoted return has an explicit state',()=>assert.equal(screen(trip(100),now).status,'zero'));
test('missing or invalid amounts are unavailable',()=>{
 assert.equal(screen(undefined,now).status,'unavailable');
 for(const amount of [NaN,Infinity,-1,0])assert.equal(screen(trip(amount),now).status,'unavailable');
 assert.equal(screen(trip(100,0),now).status,'unavailable');
});
test('single and round-trip quotes expire at exactly 30 seconds',()=>{
 assert.equal(quoteExpired(now,now+29_999),false);assert.equal(quoteExpired(now,now+30_000),true);
 assert.equal(screen(trip(102),now+30_000).status,'expired');
 assert.equal(quoteExpired(NaN,now),true);assert.equal(quoteExpired(now+10_000,now),true);
});
