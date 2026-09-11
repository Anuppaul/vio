'use client';

export type ExerciseClefKey='grand'|'treble'|'bass'|'alto'|'tenor'|'soprano'|'mezzo'|'baritone';

export const EXTRA_CLEF_CONFIG={
 grand:{label:'Grand Staff',short:'Grand Staff',glyph:'𝄞',bottom:30,glyphY:190,glyphSize:105},
 soprano:{label:'Soprano Clef',short:'Soprano',glyph:'𝄡',bottom:28,glyphY:214,glyphSize:83},
 mezzo:{label:'Mezzo-soprano Clef',short:'Mezzo-soprano',glyph:'𝄡',bottom:26,glyphY:193,glyphSize:83},
 baritone:{label:'Baritone Clef',short:'Baritone',glyph:'𝄡',bottom:20,glyphY:130,glyphSize:83}
} as const;

const placement:Record<ExerciseClefKey,{kind:'treble'|'bass'|'c'|'grand';line?:number}>={
 grand:{kind:'grand'},treble:{kind:'treble'},bass:{kind:'bass'},
 soprano:{kind:'c',line:1},mezzo:{kind:'c',line:2},alto:{kind:'c',line:3},tenor:{kind:'c',line:4},baritone:{kind:'c',line:5}
};

function StaffLines({top=10}:{top?:number}){return <>{[0,1,2,3,4].map(i=><line key={i} x1="3" y1={top+i*7} x2="41" y2={top+i*7} stroke="currentColor" strokeWidth=".8" opacity=".6"/>)}</>}

export default function ExerciseClefPreview({clef,className=''}:{clef:ExerciseClefKey;className?:string}){
 const p=placement[clef];
 if(p.kind==='grand')return <svg className={`exercise-clef-preview ${className}`} viewBox="0 0 44 96" aria-hidden="true"><StaffLines top={8}/><StaffLines top={57}/><path d="M3 6 Q0 6 0 10 V84 Q0 88 3 88" fill="none" stroke="currentColor" strokeWidth="1.5"/><text x="12" y="39" fontSize="35" textAnchor="middle" fill="currentColor">𝄞</text><text x="13" y="86" fontSize="28" textAnchor="middle" fill="currentColor">𝄢</text></svg>;
 if(p.kind==='treble')return <svg className={`exercise-clef-preview ${className}`} viewBox="0 0 44 58" aria-hidden="true"><StaffLines top={12}/><text x="13" y="48" fontSize="42" textAnchor="middle" fill="currentColor">𝄞</text></svg>;
 if(p.kind==='bass')return <svg className={`exercise-clef-preview ${className}`} viewBox="0 0 44 58" aria-hidden="true"><StaffLines top={12}/><text x="14" y="37" fontSize="31" textAnchor="middle" fill="currentColor">𝄢</text></svg>;
 const line=p.line||3,centerY=12+(line-1)*7;
 return <svg className={`exercise-clef-preview ${className}`} viewBox="0 0 44 58" aria-hidden="true"><StaffLines top={12}/><text x="14" y={centerY+13} fontSize="31" textAnchor="middle" fill="currentColor">𝄡</text></svg>;
}
