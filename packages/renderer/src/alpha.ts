/** Preserve alpha independently of color-space conversions in RGB-only effects. */
export function preserveEffectAlpha(filters:string[],prefix:string,options:{key?:boolean;alphaFilters?:string[]}={}):string[]{
 if(!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(prefix))throw new Error("Invalid internal effect label.");
 const prior=prefix+"prior",color=prefix+"color",alpha=prefix+"alpha",rgb=prefix+"rgb";
 const geometry=options.alphaFilters?.length?","+options.alphaFilters.join(","):"";
 const start=`format=rgba,split=2[${prior}][${color}];[${prior}]alphaextract${geometry}[${alpha}];[${color}]${filters.join(",")},format=rgba`;
 if(!options.key)return[start+`[${rgb}];[${rgb}][${alpha}]alphamerge`];
 return[start+`,split=2[${rgb}][${prefix}key];[${prefix}key]alphaextract[${prefix}coverage];[${alpha}][${prefix}coverage]blend=all_expr='round(A*B/255)'[${prefix}combined];[${rgb}][${prefix}combined]alphamerge`];
}
