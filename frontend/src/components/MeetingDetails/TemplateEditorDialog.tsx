'use client';

import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { Label } from '../ui/label';
import { Plus, Trash2, Loader2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';

interface Section {
  title: string;
  instruction: string;
  format: string;
  item_format?: string;
  example_item_format?: string;
}

interface TemplateData {
  name: string;
  description: string;
  sections: Section[];
}

interface TemplateEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Existing template id to edit, or null to create a new one. */
  templateId: string | null;
  /** Called with the saved template id after a successful save. */
  onSaved: (id: string) => void;
  /** Delete handler (from useTemplates). Omitted for new templates. */
  onDelete?: (id: string) => void;
}

const FORMATS = ['paragraph', 'list', 'string'];

const emptyTemplate = (): TemplateData => ({
  name: '',
  description: '',
  sections: [{ title: '', instruction: '', format: 'paragraph' }],
});

export function TemplateEditorDialog({
  open,
  onOpenChange,
  templateId,
  onSaved,
  onDelete,
}: TemplateEditorDialogProps) {
  const [data, setData] = useState<TemplateData>(emptyTemplate());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (!templateId) {
      setData(emptyTemplate());
      return;
    }
    setLoading(true);
    invoke<string>('api_get_template_full', { templateId })
      .then((json) => {
        const t = JSON.parse(json);
        setData({
          name: t.name ?? '',
          description: t.description ?? '',
          sections: (t.sections ?? []).map((s: any) => ({
            title: s.title ?? '',
            instruction: s.instruction ?? '',
            format: s.format ?? 'paragraph',
            item_format: s.item_format ?? undefined,
            example_item_format: s.example_item_format ?? undefined,
          })),
        });
      })
      .catch((e) => toast.error('Не удалось загрузить шаблон', { description: String(e) }))
      .finally(() => setLoading(false));
  }, [open, templateId]);

  const updateSection = (i: number, patch: Partial<Section>) =>
    setData((d) => ({ ...d, sections: d.sections.map((s, idx) => (idx === i ? { ...s, ...patch } : s)) }));
  const addSection = () =>
    setData((d) => ({ ...d, sections: [...d.sections, { title: '', instruction: '', format: 'paragraph' }] }));
  const removeSection = (i: number) =>
    setData((d) => ({ ...d, sections: d.sections.filter((_, idx) => idx !== i) }));

  const handleSave = async () => {
    if (!data.name.trim()) return toast.error('Название обязательно');
    if (!data.description.trim()) return toast.error('Описание обязательно');
    if (data.sections.length === 0) return toast.error('Нужен хотя бы один раздел');
    for (const s of data.sections) {
      if (!s.title.trim() || !s.instruction.trim()) {
        return toast.error('У каждого раздела нужны заголовок и инструкция');
      }
    }
    // Build payload, preserving optional format hints even though they aren't edited here.
    const payload = {
      name: data.name.trim(),
      description: data.description.trim(),
      sections: data.sections.map((s) => ({
        title: s.title.trim(),
        instruction: s.instruction.trim(),
        format: s.format,
        ...(s.item_format && s.item_format.trim() ? { item_format: s.item_format } : {}),
        ...(s.example_item_format && s.example_item_format.trim()
          ? { example_item_format: s.example_item_format }
          : {}),
      })),
    };
    setSaving(true);
    try {
      const id = await invoke<string>('api_save_template', {
        templateId: templateId ?? '',
        templateJson: JSON.stringify(payload),
      });
      toast.success('Шаблон сохранён');
      onSaved(id);
      onOpenChange(false);
    } catch (e) {
      toast.error('Не удалось сохранить', { description: String(e) });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = () => {
    if (!templateId || !onDelete) return;
    onDelete(templateId);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{templateId ? 'Редактировать шаблон' : 'Новый шаблон'}</DialogTitle>
          <DialogDescription>
            Название, описание и разделы. Инструкция каждого раздела задаёт, что модель извлечёт в него.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="py-8 flex justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1">
              <Label>Название</Label>
              <Input value={data.name} onChange={(e) => setData((d) => ({ ...d, name: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>Описание</Label>
              <Textarea
                value={data.description}
                onChange={(e) => setData((d) => ({ ...d, description: e.target.value }))}
              />
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Разделы</Label>
                <Button size="sm" variant="outline" onClick={addSection}>
                  <Plus className="h-4 w-4 mr-1" />
                  Раздел
                </Button>
              </div>
              {data.sections.map((s, i) => (
                <div key={i} className="border rounded-md p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <Input
                      placeholder="Заголовок раздела"
                      value={s.title}
                      onChange={(e) => updateSection(i, { title: e.target.value })}
                    />
                    <select
                      className="border rounded px-2 py-1 text-sm bg-white"
                      value={s.format}
                      onChange={(e) => updateSection(i, { format: e.target.value })}
                    >
                      {FORMATS.map((f) => (
                        <option key={f} value={f}>
                          {f}
                        </option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => removeSection(i)}
                      disabled={data.sections.length <= 1}
                      title="Удалить раздел"
                    >
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  </div>
                  <Textarea
                    placeholder="Инструкция для модели (что извлечь в этот раздел)"
                    value={s.instruction}
                    onChange={(e) => updateSection(i, { instruction: e.target.value })}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        <DialogFooter className="flex items-center justify-between sm:justify-between">
          {templateId && onDelete ? (
            <Button variant="outline" className="text-red-600 border-red-300" onClick={handleDelete}>
              <Trash2 className="h-4 w-4 mr-1" />
              Удалить
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Отмена
            </Button>
            <Button onClick={handleSave} disabled={saving || loading}>
              {saving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Сохранить
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
