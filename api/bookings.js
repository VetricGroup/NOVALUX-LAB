const EMAIL = 'novalux.cr@outlook.com';
const TZ = 'America/Costa_Rica';
const ALLOWED_TIMES = new Set(['08:00', '12:00', '16:00']);

function redis(command, args) {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error('Redis no está configurado');
  }
  return fetch(`${process.env.UPSTASH_REDIS_REST_URL}/${command}/${args.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` }
  }).then(async response => {
    if (!response.ok) throw new Error(`Redis respondió ${response.status}`);
    const body = await response.json();
    return body.result;
  });
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00-06:00`));
}

function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json').end(JSON.stringify(body));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'Método no permitido' });
  let slot;
  let bookingId;
  try {
    const { name, phone, email, service, date, time, consent } = req.body || {};
    if (!name || !phone || !email || !service || !validDate(date) || !ALLOWED_TIMES.has(time) || consent !== true) {
      return json(res, 400, { error: 'Completa todos los datos y acepta el consentimiento.' });
    }
    slot = `novalux:slot:${date}:${time}`;
    bookingId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const normalizedPhone = phone.replace(/[^\d]/g, '').replace(/^0+/, '');
    const booking = { id: bookingId, name, phone: normalizedPhone.length === 8 ? `506${normalizedPhone}` : normalizedPhone, email, service, date, time, timezone: TZ, reminderSent: false };
    const reserved = await redis('set', [slot, bookingId, 'NX']);
    if (reserved !== 'OK') return json(res, 409, { error: 'Ese horario ya fue reservado. Elige otro.' });
    await redis('set', [`novalux:booking:${bookingId}`, JSON.stringify(booking)]);
    await redis('sadd', ['novalux:bookings', bookingId]);

    if (!process.env.RESEND_API_KEY) throw new Error('Resend no está configurado');
    const emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || 'NOVALUX <reservas@novalux.cr>',
        to: [EMAIL],
        subject: `Nueva cita: ${name} — ${date} ${time}`,
        html: `<h2>Nueva reserva NOVALUX</h2><p><b>Cliente:</b> ${name}</p><p><b>WhatsApp:</b> ${phone}</p><p><b>Correo:</b> ${email}</p><p><b>Servicio:</b> ${service}</p><p><b>Fecha:</b> ${date} a las ${time} (Costa Rica)</p>`
      })
    });
    if (!emailResponse.ok) throw new Error('No se pudo enviar el correo');
    return json(res, 201, { message: 'Reserva confirmada. Revisa tu correo.' });
  } catch (error) {
    console.error('booking_error', error);
    if (slot && bookingId) {
      await Promise.all([
        redis('del', [slot]).catch(cleanupError => console.error('slot_cleanup_error', cleanupError)),
        redis('del', [`novalux:booking:${bookingId}`]).catch(cleanupError => console.error('booking_cleanup_error', cleanupError))
      ]);
    }
    return json(res, 500, { error: 'No pudimos completar la reserva. Intenta nuevamente.' });
  }
};
