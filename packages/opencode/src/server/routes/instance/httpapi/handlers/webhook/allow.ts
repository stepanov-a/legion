/**
 * Матчер allow-списка из фронтматтера команды.
 *
 * Вынесен из handler.ts как чистая функция, чтобы проверку доступа можно было
 * покрыть тестами без поднятия Effect-рантайма.
 *
 * Семантика — точная дорефакторная (handler.ts до коммита 5431959365):
 * - сравнение регистрозависимое, без нормализации: `toLowerCase` не применяется
 *   ни к шаблону, ни к адресу, поэтому `User@Dom.tld` и `user@dom.tld` — разные
 *   адреса, и шаблон `*@DOM.tld` не пропустит `anyone@dom.tld`;
 * - точное совпадение e-mail;
 * - wildcard-суффикс `user@dom*` — префиксное совпадение (`startsWith`);
 * - wildcard-префикс `*@dom.tld` — суффиксное совпадение (`endsWith`).
 *
 * Регистронезависимое сравнение — отдельное продуктовое решение (осознанно
 * расширяет доступ), а не побочный эффект рефакторинга. Если оно понадобится,
 * его вводят явно и тестируют отдельно.
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
  return allow.some((pattern) => {
    if (pattern === senderEmail) return true
    if (pattern.endsWith("*") && senderEmail.startsWith(pattern.slice(0, -1))) return true
    if (pattern.startsWith("*") && senderEmail.endsWith(pattern.slice(1))) return true
    return false
  })
}
