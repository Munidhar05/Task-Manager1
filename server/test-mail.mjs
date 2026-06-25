// One-off SMTP diagnostic. Run with: node --env-file=.env test-mail.mjs [recipient]
import nodemailer from 'nodemailer'

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM } = process.env
console.log('--- Config ---')
console.log('SMTP_HOST:', SMTP_HOST || '(MISSING)')
console.log('SMTP_PORT:', SMTP_PORT || '(MISSING)')
console.log('SMTP_USER:', SMTP_USER || '(MISSING)')
console.log('SMTP_PASS:', SMTP_PASS ? `(set, ${SMTP_PASS.length} chars)` : '(MISSING)')
console.log('MAIL_FROM:', MAIL_FROM || '(MISSING)')

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT || 587),
  secure: Number(SMTP_PORT) === 465,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
})

const to = process.argv[2] || SMTP_USER
try {
  console.log('\n--- Step 1: verify connection + auth ---')
  await transporter.verify()
  console.log('✅ Connection + auth OK')

  console.log(`\n--- Step 2: send test email → ${to} ---`)
  const info = await transporter.sendMail({
    from: MAIL_FROM || SMTP_USER,
    to,
    subject: 'SmartTask SMTP test',
    text: 'If you received this, your Brevo SMTP from SmartTask is working.',
  })
  console.log('✅ SENT. messageId:', info.messageId)
  console.log('   accepted:', info.accepted, ' rejected:', info.rejected)
} catch (e) {
  console.error('\n❌ FAILED:', e.message)
  if (e.code) console.error('   code:', e.code)
  if (e.command) console.error('   command:', e.command)
  if (e.response) console.error('   server response:', e.response)
}
