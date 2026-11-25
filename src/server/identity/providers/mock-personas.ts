/**
 * Fixed FAKE identities for the Mock provider (local/test only, A-050). Not real people: names are labels, phone
 * numbers use the 010-0000-xxxx test range, DIs are obviously synthetic. The user can only pick one of these by id;
 * no request can supply a DI, CI, name or phone.
 */
export const MOCK_PERSONAS = {
  A: { di: "MOCK-DI-PERSONA-A-NOT-A-REAL-PERSON", name: "테스트사용자A", phone: "01000000001" },
  B: { di: "MOCK-DI-PERSONA-B-NOT-A-REAL-PERSON", name: "테스트사용자B", phone: "01000000002" },
  C: { di: "MOCK-DI-PERSONA-C-NOT-A-REAL-PERSON", name: "테스트사용자C", phone: "01000000003" },
} as const;
export type MockPersonaId = keyof typeof MOCK_PERSONAS;

/** Choices on the mock page. `success:<persona>` | `cancel` | `fail`. */
export const MOCK_OUTCOMES = ["success:A", "success:B", "success:C", "cancel", "fail"] as const;
export type MockOutcome = (typeof MOCK_OUTCOMES)[number];
export const isMockOutcome = (v: unknown): v is MockOutcome => (MOCK_OUTCOMES as readonly unknown[]).includes(v);
