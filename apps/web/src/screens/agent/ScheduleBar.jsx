import { motion } from 'framer-motion';
import { useState } from 'react';
import { Button, Field, Input, Select } from '../../components/ui.jsx';
import { api } from '../../lib/api.js';
import { useToast } from '../../lib/toast.jsx';

const TZ = 'Asia/Kolkata';

// Half-hour slots. IST is UTC+5:30, so a whole-UTC-hour cron cannot express "9:00 IST", // the server stores the wall-clock hour plus the zone and lets BullMQ convert.
const SLOTS = Array.from({ length: 48 }, (_, i) => {
  const hour = Math.floor(i / 2);
  const minute = i % 2 ? 30 : 0;
  return {
    value: `${hour}:${minute}`,
    label: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} IST`,
  };
});

export default function ScheduleBar({ threadId, onClose, onSaved }) {
  const { bad } = useToast();
  const [title, setTitle] = useState('Daily sync');
  const [slot, setSlot] = useState('9:0');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!threadId) return bad('Run the steps in a chat first, then schedule that thread.');
    const [hour, minute] = slot.split(':').map(Number);
    setBusy(true);
    try {
      const res = await api('/api/agent/playbooks', {
        body: {
          title: title.trim() || 'Daily sync',
          instruction: title.trim() || 'Daily sync',
          threadId,
          scheduleKind: 'daily',
          hourUtc: hour,
          scheduleMinute: minute,
          timezone: TZ,
          activate: true,
        },
      });
      onSaved?.(res.note);
    } catch (err) {
      // The server refuses steps whose tools it does not recognise; that list is the
      // most useful part of the message.
      const unknown = err.body?.unknownTools;
      bad(unknown?.length ? `${err.message} (${unknown.join(', ')})` : err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.form
      className="schedule-bar"
      onSubmit={submit}
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
    >
      <Field label="Name">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} placeholder="Daily sheet sync" />
      </Field>
      <Field label="Runs at">
        <Select value={slot} onChange={(e) => setSlot(e.target.value)}>
          {SLOTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </Select>
      </Field>
      <div className="schedule-actions">
        <Button variant="primary" type="submit" loading={busy}>Schedule</Button>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
      <p className="meta schedule-hint">
        The tools this thread already ran become the daily steps. It runs on the worker,
        as you, and every run appears in Recent activity.
      </p>
    </motion.form>
  );
}
