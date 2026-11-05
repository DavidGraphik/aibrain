import { describe, expect, it } from "vitest";
import { makeAutoFilterProfile } from "../../tests/fixtures/legacy-autofilter";
import { inspectAutoFilterDrawings } from "./legacy-excel-autofilter";
const inspect = (p: ReturnType<typeof makeAutoFilterProfile>) => inspectAutoFilterDrawings(p.global, p.sheets);
const cases: [string, (profile: ReturnType<typeof makeAutoFilterProfile>) => void][] = [
 ['macro-object-type',p=>p.sheets[0].pairs[0].object.writeUInt16LE(7,4)],
 ['picture-object-type',p=>p.sheets[0].pairs[0].object.writeUInt16LE(8,4)],
 ['activex-object-type',p=>p.sheets[0].pairs[0].object.writeUInt16LE(0x1e,4)],
 ['object-fmla',p=>p.sheets[0].pairs[0].object.writeUInt16LE(2,50)],
 ['macro-subrecord',p=>p.sheets[0].pairs[0].object.writeUInt16LE(4,22)],
 ['linked-range-subrecord',p=>p.sheets[0].pairs[0].object.writeUInt16LE(0xe,22)],
 ['general-dropdown-class',p=>p.sheets[0].pairs[0].object.writeUInt16LE(1,56)],
 ['pivot-dropdown-class',p=>p.sheets[0].pairs[0].object.writeUInt16LE(0x101,56)],
 ['list-strings',p=>p.sheets[0].pairs[0].object.writeUInt16LE(0x303,56)],
 ['edit-control',p=>p.sheets[0].pairs[0].object.writeUInt16LE(4,58)],
 ['nonempty-control-string',p=>p.sheets[0].pairs[0].object.writeUInt16LE(1,66)],
 ['unvalidated-padding',p=>p.sheets[0].pairs[0].object[69]=0xff],
 ['truncated-object',p=>p.sheets[0].pairs[0].object=p.sheets[0].pairs[0].object.subarray(0,69)],
 ['extra-object-payload',p=>p.sheets[0].pairs[0].object=Buffer.concat([p.sheets[0].pairs[0].object,Buffer.from([4,0,0,0])])],
 ['continued-object',p=>p.sheets[0].pairs[0].object.writeUInt16LE(19,48)],
 ['duplicate-object-id',p=>p.sheets[0].pairs[1].object.writeUInt16LE(1,6)],
 ['missing-autofilter',p=>p.sheets[0].filterColumns=0],
 ['count-mismatch',p=>p.sheets[0].filterColumns=2],
 ['missing-drawing',p=>p.sheets[0].pairs[0].drawing=Buffer.alloc(0)],
 ['clientdata-payload',p=>p.sheets[0].pairs[1].drawing.writeUInt32LE(1,p.sheets[0].pairs[1].drawing.length-4)],
 ['ole-shape-flag',p=>p.sheets[0].pairs[1].drawing.writeUInt32LE(0xa10,20)],
 ['unknown-shape-type',p=>p.sheets[0].pairs[1].drawing.writeUInt16LE((202<<4)|2,8)],
 ['hyperlink-property',p=>p.sheets[0].pairs[1].drawing.writeUInt16LE(0x382,32)],
 ['complex-property',p=>p.sheets[0].pairs[1].drawing.writeUInt16LE(0x807f,32)],
 ['resource-property',p=>p.sheets[0].pairs[1].drawing.writeUInt16LE(0x407f,32)],
 ['unknown-property',p=>p.sheets[0].pairs[1].drawing.writeUInt16LE(0x03aa,32)],
 ['truncated-drawing',p=>p.sheets[0].pairs[1].drawing=p.sheets[0].pairs[1].drawing.subarray(0,60)],
 ['drawing-bounds',p=>p.sheets[0].pairs[1].drawing.writeUInt32LE(0xffffffff,4)],
 ['global-complex-property',p=>{const at=p.global.indexOf(Buffer.from('bf0008000800','hex'));expect(at).toBeGreaterThan(0);p.global.writeUInt16LE(0x80bf,at);}],
 ['global-unknown-child',p=>p.global.writeUInt16LE(0xf001,10)],
 ['global-trailing-data',p=>p.global=Buffer.concat([p.global,Buffer.alloc(8)])],
 ['missing-global-drawing',p=>p.global=Buffer.alloc(0)],
 ['unbounded-shape-id-space',p=>p.global.writeUInt32LE(0xffffffff,16)],
 ['unbounded-cluster-count',p=>p.global.writeUInt32LE(0xffffffff,36)],
 ['unbound-drawing-cluster',p=>p.global.writeUInt32LE(2,32)],
 ['shape-id-outside-declared-space',p=>p.sheets[0].pairs[1].drawing.writeUInt32LE(0xffffffff,16)],
];

describe("strict legacy Excel AutoFilter profile", () => {
  it.each([1, 3, 30, 256])("recognizes %i inert filter buttons", columns => {
    expect(inspect(makeAutoFilterProfile(columns))).toEqual({ classifiedFilterButtons: columns, sheets: 1 });
  });
  it("recognizes separate filter drawings on multiple sheets", () => {
    expect(inspect(makeAutoFilterProfile([2, 5]))).toEqual({ classifiedFilterButtons: 7, sheets: 2 });
  });
  it("accepts bounded cached selections and dropdown dimensions independently of cell data", () => {
    const profile = makeAutoFilterProfile(1);
    profile.sheets[0].pairs[0].object.writeUInt16LE(6, 54);
    profile.sheets[0].pairs[0].object.writeUInt16LE(12, 62);
    profile.sheets[0].pairs[0].object.writeUInt16LE(100, 64);
    expect(inspect(profile)).toEqual({ classifiedFilterButtons: 1, sheets: 1 });
  });
  it("rejects colliding drawing IDs across sheets", () => {
    const profile = makeAutoFilterProfile([2, 5]);
    profile.sheets[1].pairs[0].drawing.writeUInt16LE(1 << 4, 8);
    expect(() => inspect(profile)).toThrow("unsupported-autofilter-profile");
  });
  it.each(cases)("rejects %s", (_name, mutate) => {
    const profile = makeAutoFilterProfile();
    mutate(profile);
    expect(() => inspect(profile)).toThrow("unsupported-autofilter-profile");
  });
});
