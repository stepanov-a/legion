/**
 * Матчер allow-списка из фронтматтера команды.
 *
 * Вынесен из handler.ts как чистая функция, чтобы проверку доступа можно было
 * покрыть тестами без поднятия Effect-рантайма.
 *
 * Семантика (сохранена байт-в-байт из handler.ts):
 * - сравнение регистронезависимое (`toLowerCase` с обеих сторон);
 * - точное совпадение e-mail;
 * - wildcard-суффикс `user@dom*` — префиксное совпадение (`startsWith`);
 * - wildcard-префикс `*@dom.tld` — суффиксное совпадение (`endsWith`).
 *
 * Пустой массив означает «никого не пропускать» на уровне этой функции;
 * «без ограничений» — это решение вызывающего кода (handler проверяет
 * `allow.length > 0` и при пустом списке матчер не вызывает).
 *
 * @param allow список шаблонов из фронтматтера (`allow: ["*@dom.tld"]`)
 * @param senderEmail e-mail отправителя из вебхука Zulip
 * @returns true, если отправитель проходит хотя бы один шаблон
 */
export function matchesAllow(allow: string[], senderEmail: string): boolean {
  const lowerEmail = senderEmail.toLowerCase()
  return allow.some((pattern) => {
    const lowerPattern = pattern.toLowerCase()
    if (lowerPattern === lowerEmail) return true
    if (lowerPattern.endsWith("*") && lowerEmail.startsWith(lowerPattern.slice(0, -1))) return true
    if (lowerPattern.startsWith("*") && lowerEmail.endsWith(lowerPattern.slice(1))) return true
    return false
  })
}
