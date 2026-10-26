// Read SwiftUI's string-literal overload without interpreting interpolated values.
// A dynamic Text(value) is opaque; Text("... \(value)") is a localized format.
export function swiftUIStrings(source) {
 const starts=/\b(?:Text|Button|Label|Section|TextField|SecureField|Toggle|Picker|PhotosPicker|NavigationLink|ContentUnavailableView|DisclosureGroup|navigationTitle|accessibilityLabel|alert|confirmationDialog)\(\s*"/g;
 const found=[];
 for(const match of source.matchAll(starts)) {
  let i=match.index+match[0].length, parts=[''], expressions=[], valid=false;
  for(;i<source.length;i++) {
   const c=source[i];
   if(c==='"'){valid=true;break;}
   if(c!=='\\'){parts[parts.length-1]+=c;continue;}
   if(source[i+1]!=='('){parts[parts.length-1]+=source.slice(i,i+2);i++;continue;}
   let depth=1,start=i+2,quoted=false; i+=2;
   for(;i<source.length&&depth;i++) {
    if(source[i]==='\\'){i++;continue;}
    if(source[i]==='"'){quoted=!quoted;continue;}
    if(!quoted){if(source[i]==='(')depth++;else if(source[i]===')')depth--;}
   }
   expressions.push(source.slice(start,i-1));parts.push('');i--;
  }
  if(valid) found.push({parts,expressions,literal:source.slice(match.index+match[0].length,i)});
 }
 return found;
}
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function catalogKeysForFormat(format, keys) {
 const pattern=new RegExp('^'+format.parts.map(escape).join('%(?:@|lld|ld|d|f)')+'$');
 return keys.filter(key=>pattern.test(key));
}
