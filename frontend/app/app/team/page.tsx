"use client";

import { Copy, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, Badge, Button, Code, Dialog, Field, Input, Loading, PageHeader, Select, Table } from "@/components/ui";
import { del, patch, post } from "@/lib/api";
import { useAction, useList, useMe } from "@/lib/hooks";
import { ago, can, ROLE_RANK, type Role } from "@/lib/utils";

type Member = { user_id: string; name: string; email: string; role: Role; department: string | null; mfa_enabled: boolean; joined_at: string };
type Inv = { id: string; email: string; role: string; expires_at: string };
const ROLES: [Role, string][] = [["viewer", "Viewer — read only"], ["employee", "Employee — tasks and test runs"], ["manager", "Manager — agents, workflows, approvals"], ["admin", "Admin — integrations, team, billing"], ["owner", "Owner — everything"]];

export default function Team() {
  const me = useMe();
  const members = useList<Member[]>(["members"], "/team/members");
  const admin = can(me.data?.org?.role, "admin");
  const invites = useList<Inv[]>(["invites"], "/team/invitations", { enabled: admin });
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("employee");
  const [link, setLink] = useState<string | null>(null);
  const myRank = ROLE_RANK[me.data?.org?.role ?? "viewer"];
  const invite = useAction(() => post<{ invite_url: string }>("/team/invitations", { email, role }), { invalidate: [["invites"]], onSuccess: (r) => { setLink(r.invite_url); setEmail(""); } });
  const update = useAction((v: { id: string; role: Role }) => patch(`/team/members/${v.id}`, { role: v.role }), { success: "Role updated", invalidate: [["members"]] });
  const remove = useAction((id: string) => del(`/team/members/${id}`), { success: "Member removed", invalidate: [["members"]] });
  const revoke = useAction((id: string) => del(`/team/invitations/${id}`), { success: "Invitation revoked", invalidate: [["invites"]] });
  return (
    <>
      <PageHeader title="Team & Access" description="People in this organisation and what they can do. Roles are enforced on the server for every request."
        actions={admin && <Button onClick={() => { setLink(null); setOpen(true); }}><Plus className="h-4 w-4" aria-hidden />Invite</Button>} />
      {members.isLoading ? <Loading /> : (
        <Table head={["Name", "Role", "Department", "MFA", "Joined", ""]}>
          {members.data?.map((m) => (
            <tr key={m.user_id}><td className="px-4 py-3"><p className="font-medium">{m.name}</p><p className="text-xs text-text-3">{m.email}</p></td>
              <td className="px-4 py-3">{admin && m.user_id !== me.data?.user.id && ROLE_RANK[m.role] <= myRank ? (
                <Select aria-label={`Role for ${m.name}`} className="w-36" value={m.role} onChange={(e) => update.mutate({ id: m.user_id, role: e.target.value as Role })}>
                  {ROLES.filter(([r]) => ROLE_RANK[r] <= myRank).map(([r]) => <option key={r} value={r}>{r}</option>)}</Select>) : <Badge className="capitalize">{m.role}</Badge>}</td>
              <td className="px-4 py-3 text-text-2">{m.department ?? "—"}</td>
              <td className="px-4 py-3">{m.mfa_enabled ? <Badge tone="good"><ShieldCheck className="h-3 w-3" aria-hidden />on</Badge> : <Badge>off</Badge>}</td>
              <td className="px-4 py-3 text-text-3">{ago(m.joined_at)}</td>
              <td className="px-4 py-3 text-right">{admin && m.user_id !== me.data?.user.id && <Button size="icon" variant="ghost" aria-label={`Remove ${m.name}`} onClick={() => confirm(`Remove ${m.name}?`) && remove.mutate(m.user_id)}><Trash2 className="h-4 w-4" /></Button>}</td></tr>))}
        </Table>
      )}
      {admin && !!invites.data?.length && <><h2 className="mb-3 mt-8 font-semibold">Pending invitations</h2>
        <Table head={["Email", "Role", "Expires", ""]}>{invites.data.map((i) => <tr key={i.id}><td className="px-4 py-3">{i.email}</td><td className="px-4 py-3 capitalize">{i.role}</td><td className="px-4 py-3 text-text-3">{ago(i.expires_at)}</td>
          <td className="px-4 py-3 text-right"><Button size="sm" variant="ghost" onClick={() => revoke.mutate(i.id)}>Revoke</Button></td></tr>)}</Table></>}
      <div className="mt-8"><Alert title="Agencies">Use the organisation switcher (top left) to create a separate, fully isolated organisation for each client.</Alert></div>
      <Dialog open={open} onOpenChange={setOpen} title="Invite a team member" footer={!link && <><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={!email} loading={invite.isPending} onClick={() => invite.mutate(undefined)}>Create invitation</Button></>}>
        {link ? <div className="space-y-3 text-sm"><p>Send this link to the person you invited. It works once and expires in 7 days.</p><Code>{link}</Code>
          <Button size="sm" variant="secondary" onClick={() => { navigator.clipboard?.writeText(link); toast.success("Copied"); }}><Copy className="h-3.5 w-3.5" aria-hidden />Copy link</Button></div> : (
          <div className="space-y-4"><Field label="Email">{(id) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
            <Field label="Role">{(id) => <Select id={id} value={role} onChange={(e) => setRole(e.target.value as Role)}>{ROLES.filter(([r]) => ROLE_RANK[r] <= myRank).map(([r, l]) => <option key={r} value={r}>{l}</option>)}</Select>}</Field></div>)}
      </Dialog>
    </>
  );
}
