# Supabase email templates

Use custom SMTP with your verified sender. Set the Site URL to the canonical frontend URL. Add these two bilingual templates in Supabase Auth. The app accepts the numeric codes through its Worker-hosted forms.

## Confirm signup

Subject

    Blackjack Royale — Verifica email / Verify your email

Body

    <h2>Blackjack Royale</h2>
    <p>Inserisci questo codice nella pagina di verifica per confermare la tua email.</p>
    <p>Enter this code on the verification page to confirm your email address.</p>
    <p><strong>{{ .Token }}</strong></p>
    <p>Ignora il messaggio se non hai creato un account. / Ignore this message if you did not create an account.</p>

## Reset password

Subject

    Blackjack Royale — Recupero password / Password recovery

Body

    <h2>Blackjack Royale</h2>
    <p>Inserisci questo codice nella pagina di recupero e scegli una nuova password.</p>
    <p>Enter this code on the recovery page and choose a new password.</p>
    <p><strong>{{ .Token }}</strong></p>
    <p>Ignora il messaggio se non hai chiesto il recupero. / Ignore this message if you did not request a reset.</p>

[Supabase email template fields](https://supabase.com/docs/guides/auth/auth-email-templates)
