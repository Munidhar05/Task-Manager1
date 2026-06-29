import React from 'react'
import { Link } from 'react-router-dom'

// Public, standalone privacy policy — reachable at /privacy without signing in
// (required for the Google Play listing) and linked from the login screen and the
// in-app sidebar. NOTE: review the contact address and company details below with
// your team / legal before publishing.
const EFFECTIVE_DATE = '29 June 2026'
const CONTACT_EMAIL = 'privacy@befach.com'

export default function PrivacyPolicy() {
  return (
    <div className="legal-wrap" style={{ maxWidth: 820, margin: '0 auto', padding: '32px 20px 64px' }}>
      <div className="row" style={{ gap: 12, alignItems: 'center', marginBottom: 18 }}>
        <img src="/logo.png" alt="Befach Task Manager" style={{ width: 40, height: 40, borderRadius: 9, objectFit: 'cover', background: '#fff' }} />
        <div>
          <h1 style={{ margin: 0, fontSize: 24 }}>Privacy Policy</h1>
          <div className="muted" style={{ fontSize: 13 }}>Befach Task Manager · Effective {EFFECTIVE_DATE}</div>
        </div>
      </div>

      <div className="card" style={{ padding: '22px 24px', lineHeight: 1.65, fontSize: 14.5 }}>
        <p>This Privacy Policy explains how <strong>Befach Task Manager</strong> ("the App", "we", "us") collects,
          uses, and protects your information when you use the application and related services. By creating an
          account or using the App, you agree to the practices described here.</p>

        <h3>1. Information we collect</h3>
        <ul>
          <li><strong>Account information</strong> — your name, email address, phone number (optional), role, organization, and an encrypted (hashed) password.</li>
          <li><strong>Content you create</strong> — tasks, comments, projects, chat messages, and uploaded attachments.</li>
          <li><strong>Meeting & voice data</strong> — audio you record for transcription and the resulting text transcripts and summaries.</li>
          <li><strong>Usage &amp; device data</strong> — push-notification tokens, basic activity logs, and technical information needed to operate the service.</li>
        </ul>

        <h3>2. How we use your information</h3>
        <ul>
          <li>To provide core features: managing tasks, meetings, chats, notifications, and AI assistance.</li>
          <li>To transcribe speech, generate summaries, and answer questions about your tasks.</li>
          <li>To send transactional emails (invitations, email verification, password resets, digests).</li>
          <li>To secure the service, prevent abuse, and meet legal obligations.</li>
        </ul>

        <h3>3. AI &amp; third-party processors</h3>
        <p>To deliver voice and AI features, content you submit (such as audio, transcripts, or questions) may be sent
          to trusted third-party processors strictly to perform that task, including speech-to-text and large-language-model
          providers (for example Sarvam AI, OpenAI, Anthropic, OpenRouter, and/or Groq). We also use service providers
          for hosting and email delivery. These providers process data on our behalf and are not permitted to use it for
          their own purposes. We do <strong>not</strong> sell your personal information.</p>

        <h3>4. Data sharing</h3>
        <p>Your content is visible only within your organization according to your role and the App's permissions
          (for example, managers and admins may see team tasks). We do not share your personal data with other parties
          except the processors described above, or where required by law.</p>

        <h3>5. Data retention</h3>
        <p>We keep your information for as long as your account is active or as needed to provide the service. When an
          organization or account is deleted, its associated data is removed from our active systems. Backups and logs
          may persist for a limited period before being overwritten.</p>

        <h3>6. Security</h3>
        <p>We use industry-standard safeguards, including encrypted passwords and encrypted data transmission (HTTPS).
          No method of transmission or storage is completely secure, but we work to protect your information.</p>

        <h3>7. Your rights</h3>
        <p>You may access, update, or request deletion of your personal data. Account profile details can be edited in the
          App, and you can contact us to exercise any other rights available to you under applicable law.</p>

        <h3>8. Children's privacy</h3>
        <p>The App is intended for workplace use and is not directed to children under 13 (or the minimum age in your
          jurisdiction). We do not knowingly collect data from children.</p>

        <h3>9. Changes to this policy</h3>
        <p>We may update this Privacy Policy from time to time. Material changes will be reflected by updating the
          effective date above and, where appropriate, by notice within the App.</p>

        <h3>10. Contact us</h3>
        <p>For privacy questions or requests, contact us at <a href={`mailto:${CONTACT_EMAIL}`} style={{ color: 'var(--primary)', fontWeight: 600 }}>{CONTACT_EMAIL}</a>.</p>
      </div>

      <div style={{ marginTop: 18 }}>
        <Link to="/login" style={{ color: 'var(--primary)', fontWeight: 600 }}>← Back to sign in</Link>
      </div>
    </div>
  )
}
