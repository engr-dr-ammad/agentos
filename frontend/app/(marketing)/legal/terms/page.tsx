import { Prose } from "../../prose";

export const metadata = { title: "Terms" };

export default function Terms() {
  return (
    <Prose title="Terms of service" lead="Template — the operator of this deployment must replace this text with terms reviewed by a lawyer.">
      <section><h2>Responsibility for decisions</h2><p>AI agents produce proposals. Customers remain responsible for business decisions and for reviewing actions before approval. Agents are software and do not exercise human judgement.</p></section>
      <section><h2>Acceptable use</h2><p>The service may not be used for practices prohibited by the EU AI Act or applicable law, or for regulated decisions without the required assessments and oversight.</p></section>
    </Prose>
  );
}
