import { useState, type FormEvent } from 'react';
import type { ProjectInput } from '../lib/api';

interface ProjectFormProps {
  initialValues?: ProjectInput;
  submitLabel: string;
  onSubmit: (values: ProjectInput) => Promise<void>;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
}

const emptyValues: ProjectInput = { name: '', description: null, repositoryUrl: null };

export function ProjectForm({
  initialValues = emptyValues,
  submitLabel,
  onSubmit,
  onCancel,
  saving,
  error,
}: ProjectFormProps) {
  const [name, setName] = useState(initialValues.name);
  const [description, setDescription] = useState(initialValues.description ?? '');
  const [repositoryUrl, setRepositoryUrl] = useState(initialValues.repositoryUrl ?? '');
  const [validationError, setValidationError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedDescription = description.trim();
    const trimmedUrl = repositoryUrl.trim();

    if (!trimmedName) {
      setValidationError('Enter a project name.');
      return;
    }
    if (trimmedName.length > 100) {
      setValidationError('Project names can be at most 100 characters.');
      return;
    }
    if (trimmedDescription.length > 1000) {
      setValidationError('Descriptions can be at most 1000 characters.');
      return;
    }
    if (trimmedUrl && !/^https?:\/\//i.test(trimmedUrl)) {
      setValidationError('Enter a repository URL beginning with https:// or http://.');
      return;
    }
    try {
      new URL(trimmedUrl);
    } catch {
      if (trimmedUrl) {
        setValidationError('Enter a valid repository URL.');
        return;
      }
    }

    setValidationError(null);
    await onSubmit({
      name: trimmedName,
      description: trimmedDescription || null,
      repositoryUrl: trimmedUrl || null,
    });
  }

  return (
    <form className="project-form" onSubmit={handleSubmit} noValidate>
      <label className="form-field">
        <span>Project name <span className="required-mark">*</span></span>
        <input autoFocus required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Payments API" />
        <small>A clear name to identify this project in DockerPilot.</small>
      </label>
      <label className="form-field">
        <span>Description <span className="optional-label">OPTIONAL</span></span>
        <textarea rows={4} maxLength={1000} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What does this project do?" />
        <small>{description.length}/1000 characters</small>
      </label>
      <label className="form-field">
        <span>Repository URL <span className="optional-label">OPTIONAL</span></span>
        <input type="url" value={repositoryUrl} onChange={(event) => setRepositoryUrl(event.target.value)} placeholder="https://github.com/your-org/your-project" />
        <small>Save a repository reference for future integrations.</small>
      </label>
      {(validationError || error) && <div className="form-message error-message" role="alert">{validationError || error}</div>}
      <div className="form-actions">
        <button className="secondary-button" type="button" onClick={onCancel} disabled={saving}>Cancel</button>
        <button className="primary-button" type="submit" disabled={saving}>{saving ? 'Saving…' : submitLabel}</button>
      </div>
    </form>
  );
}
