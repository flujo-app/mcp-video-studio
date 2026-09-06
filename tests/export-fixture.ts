/** Independent reader for the stored entries and central directory emitted by this package. */
export function storedZipEntries(zip:Buffer):Map<string,Buffer>{
 const eocd=zip.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));if(eocd<0)throw new Error("Missing ZIP end record");
 let central=zip.readUInt32LE(eocd+16),count=zip.readUInt16LE(eocd+10);
 if(central===0xffffffff||count===0xffff){const locator=eocd-20;if(zip.readUInt32LE(locator)!==0x07064b50)throw new Error("Missing ZIP64 locator");const end=Number(zip.readBigUInt64LE(locator+8));if(zip.readUInt32LE(end)!==0x06064b50)throw new Error("Missing ZIP64 end record");central=Number(zip.readBigUInt64LE(end+48));count=Number(zip.readBigUInt64LE(end+32));}
 const result=new Map<string,Buffer>();
 for(let i=0;i<count;i++){
  if(zip.readUInt32LE(central)!==0x02014b50)throw new Error("Invalid central directory");
  if(zip.readUInt16LE(central+10)!==0)throw new Error("This fixture expects stored PNG entries");
  const length=zip.readUInt32LE(central+24),nameLength=zip.readUInt16LE(central+28),extra=zip.readUInt16LE(central+30),comment=zip.readUInt16LE(central+32),offset=zip.readUInt32LE(central+42);
  const name=zip.toString("utf8",central+46,central+46+nameLength);if(zip.readUInt32LE(offset)!==0x04034b50)throw new Error("Invalid local entry");
  const start=offset+30+zip.readUInt16LE(offset+26)+zip.readUInt16LE(offset+28);result.set(name,zip.subarray(start,start+length));central+=46+nameLength+extra+comment;
 }
 return result;
}
