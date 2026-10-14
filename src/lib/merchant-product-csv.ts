/** RFC 4180-compatible, bounded browser CSV parser; preserves commas and newlines in quoted values. */
export function parseCsvRecords(text:string):string[][] {
 if(text.length>1_048_576)throw new Error('CSV must be 1 MB or smaller');
 const source=text.replace(/^\uFEFF/,"");
 const rows:string[][]=[];
 let row:string[]=[],field="",quoted=false,closed=false;
 function pushField(){row.push(field.trim());field="";closed=false}
 function pushRow(){pushField();if(row.some(value=>value.length>0))rows.push(row);row=[];if(rows.length>202)throw new Error('Import at most 200 products per batch')}
 for(let i=0;i<source.length;i++){
  const ch=source[i];
  if(quoted){
   if(ch==='"'&&source[i+1]==='"'){field+='"';i++}
   else if(ch==='"'){quoted=false;closed=true}
   else field+=ch;
  }else if(ch==='"'){
   if(field.trim()||closed)throw new Error('Unexpected quote in CSV field');
   quoted=true;
  }else if(ch===',')pushField();
  else if(ch==='\n'||ch==='\r'){
   if(ch==='\r'&&source[i+1]==='\n')i++;
   pushRow();
  }else if(closed){
   if(ch!==' '&&ch!=='\t')throw new Error('Unexpected characters after closing CSV quote');
  }else field+=ch;
 }
 if(quoted)throw new Error('CSV contains an unclosed quoted field');
 if(row.length||field.trim()||closed)pushRow();
 return rows;
}
