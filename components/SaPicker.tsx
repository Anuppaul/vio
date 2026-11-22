import { SA_KEYS } from '@/lib/riyaaz';

export default function SaPicker({ note, onChange }: { note: string; onChange: (note: string) => void }) {
  return (
    <div className="control">
      <div className="control-label"><span>Sa / Key</span></div>
      <div className="key-grid" role="group" aria-label="Sa / Key">
        {SA_KEYS.map(key => <button type="button" key={key} className={note === key ? 'active' : ''}
          aria-pressed={note === key} onClick={() => onChange(key)}>{key}</button>)}
      </div>
    </div>
  );
}
