import { Prose } from "../../prose";

export const metadata = { title: "Privacy policy" };

export default function Privacy() {
  return (
    <Prose title="Privacy policy" lead="Template — the operator of this deployment must complete this policy, including controller details, lawful bases and sub-processors.">
      <section><h2>What is processed</h2><p>Account data (name, email), organisation settings, workflow content, uploaded documents and execution records. Content sent to an AI model is processed by the model provider the organisation has chosen.</p></section>
      <section><h2>Your rights</h2><p>Organisation administrators can run access and erasure requests under <b>Settings → Privacy</b>. Retention periods are configurable per organisation.</p></section>
    </Prose>
  );
}
