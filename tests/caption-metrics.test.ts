import {expect,it} from "vitest";
import {drawtextMetricValues} from "../packages/renderer/src/caption-metrics.js";
it.each([
 ["bare","900000000.000000\n123.000000\n900000001.000000\n27.000000\n"],
 ["Eval context","[Eval @ 0x7f122ad30] 900000000.000000\n[Eval @ 0x7f122ad30] 123.000000\n[Eval @ 0x7f122ad30] 900000001.000000\n[Eval @ 0x7f122ad30] 27.000000\n"],
 ["nested contexts and CRLF","[Parsed_drawtext_0 @ 000001abc] [Eval @ 000002def] 900000000.000000\r\n[Parsed_drawtext_0 @ 000001abc] [Eval @ 000002def] 123.000000\r\n[Eval @ 000002def] 900000001.000000\r\n[Eval @ 000002def] 27.000000\r\n"]
])("reads actual drawtext expression dimensions from %s logs",(_name,stderr)=>{
 expect([...drawtextMetricValues(stderr,1)]).toEqual([[900000000,123],[900000001,27]]);
});
it("ignores diagnostic prose, non-finite dimensions and unrequested marker IDs",()=>{
 const result=drawtextMetricValues("input warning 900000000.000000\n123.000000\n900000090.000000\n45.000000\n900000000.000000\nnan\n900000001.000000\n27.000000\n",1);
 expect([...result]).toEqual([[900000001,27]]);
});
