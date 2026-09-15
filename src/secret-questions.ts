import { randomUUID } from 'node:crypto';
import { validateHostInteractionResponse, type HostQuestionInteraction, type HostQuestionResponse } from './contracts.js';

/** Answers live only in the waiting call; they never enter session events or sidecars. */
export class SecretQuestions {
  private readonly pending = new Map<string, { id: string; sessionId: string; interaction: HostQuestionInteraction; resolve: (answer: HostQuestionResponse | undefined) => void }>();
  read(sessionId: string) {
    const entry = [...this.pending.values()].find(entry => entry.sessionId === sessionId);
    return entry ? { id: entry.id, title: entry.interaction.title ?? '请回答问题', questions: entry.interaction.questions.map(question =>
      question.type === 'text' ? { ...question, prefill: undefined } : question) } : null;
  }
  ask(sessionId: string, interaction: HostQuestionInteraction, signal: AbortSignal): Promise<HostQuestionResponse | undefined> {
    signal.throwIfAborted();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = () => { this.pending.delete(id); signal.removeEventListener('abort', abort); if (timer) clearTimeout(timer); };
      const abort = () => { finish(); reject(new Error('保密问题已取消或过期')); };
      const timer = interaction.expiresAt ? setTimeout(abort, Math.max(0, Date.parse(interaction.expiresAt) - Date.now())) : undefined;
      this.pending.set(id, { id, sessionId, interaction, resolve: answer => { finish(); resolve(answer); } });
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  cancel(sessionId: string, interactionId: string): void {
    const entry = [...this.pending.values()].find(entry => entry.sessionId === sessionId && entry.interaction.interactionId === interactionId);
    if (entry) entry.resolve(undefined);
  }
  answer(sessionId: string, id: string, response: HostQuestionResponse): void {
    const entry = this.pending.get(id);
    if (!entry || entry.sessionId !== sessionId) throw new Error('该问题已关闭或不属于当前会话');
    const invalid = validateHostInteractionResponse(entry.interaction, response);
    if (invalid) throw new Error(invalid.message);
    entry.resolve(response);
  }
}
