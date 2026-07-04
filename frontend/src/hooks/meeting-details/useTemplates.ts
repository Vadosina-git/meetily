import { useState, useEffect, useCallback } from 'react';
import { invoke as invokeTauri } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import Analytics from '@/lib/analytics';

export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
}

export function useTemplates() {
  const [availableTemplates, setAvailableTemplates] = useState<TemplateInfo[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>('standard_meeting');

  const refetchTemplates = useCallback(async () => {
    try {
      const templates = await invokeTauri('api_list_templates') as TemplateInfo[];
      setAvailableTemplates(templates);
      return templates;
    } catch (error) {
      console.error('Failed to fetch templates:', error);
      return [];
    }
  }, []);

  // Fetch available templates on mount
  useEffect(() => {
    refetchTemplates();
  }, [refetchTemplates]);

  // Handle template selection
  const handleTemplateSelection = useCallback((templateId: string, templateName: string) => {
    setSelectedTemplate(templateId);
    toast.success('Template selected', {
      description: `Using "${templateName}" template for summary generation`,
    });
    Analytics.trackFeatureUsed('template_selected');
  }, []);

  // Delete a template, refresh the list, and reset selection if needed
  const deleteTemplate = useCallback(async (templateId: string) => {
    try {
      await invokeTauri('api_delete_template', { templateId });
      const remaining = await refetchTemplates();
      setSelectedTemplate((cur) => {
        if (cur !== templateId) return cur;
        return remaining.some((t) => t.id === 'standard_meeting') ? 'standard_meeting' : (remaining[0]?.id ?? 'standard_meeting');
      });
      toast.success('Template deleted');
    } catch (error) {
      console.error('Failed to delete template:', error);
      toast.error('Failed to delete template', { description: String(error) });
    }
  }, [refetchTemplates]);

  return {
    availableTemplates,
    selectedTemplate,
    handleTemplateSelection,
    refetchTemplates,
    deleteTemplate,
  };
}
