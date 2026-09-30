const JOURS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

const MINUTES_JOUR = 24 * 60;
const MINUTES_SEMAINE = 7 * MINUTES_JOUR;

const sansAccents = (texte) => String(texte).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// "18:00", "18h00", "18h", "6:30" -> "18:00", "18:00", "18:00", "06:30" ; null si invalide
const normaliserHeure = (valeur) => {
    const correspondance = String(valeur).trim().toLowerCase().match(/^(\d{1,2})\s*[:h]\s*(\d{2})?$/);
    if (!correspondance) return null;
    const heures = Number(correspondance[1]);
    const minutes = Number(correspondance[2] ?? 0);
    if (heures > 23 || minutes > 59) return null;
    return `${String(heures).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
};

// ["Lundi", "mardi"] ou "lundi,mardi" -> ["lundi", "mardi"] (ordre de la semaine, sans doublon) ; null si un jour est invalide
const normaliserJours = (valeur) => {
    const liste = Array.isArray(valeur) ? valeur : String(valeur).split(',');
    const jours = liste.map(sansAccents).filter(Boolean);
    if (!jours.length || jours.some((jour) => !JOURS.includes(jour))) return null;
    return JOURS.filter((jour) => jours.includes(jour));
};

const enMinutes = (heure) => {
    const [heures, minutes] = heure.split(':').map(Number);
    return heures * 60 + minutes;
};

// Créneaux de service sur une semaine, en minutes depuis lundi 00:00.
// Un jour de service est le jour où le service COMMENCE : lundi 18:00 -> 06:00 finit mardi à 06:00.
// Heure de fin = heure de début : service de 24 h. Sans horaire : journée entière.
const creneaux = ({ heureDebut, heureFin, joursService }) => {
    const jours = joursService?.length ? joursService : JOURS;
    const debut = heureDebut ? enMinutes(heureDebut) : 0;
    const fin = heureFin ? enMinutes(heureFin) : 0;
    const duree = fin > debut ? fin - debut : fin + MINUTES_JOUR - debut;
    return jours.map((jour) => {
        const depart = JOURS.indexOf(jour) * MINUTES_JOUR + debut;
        return [depart, depart + duree];
    });
};

// Vrai si deux services (horaires + jours) se croisent dans la semaine (dimanche soir -> lundi matin compris)
const horairesSeChevauchent = (a, b) => {
    const creneauxB = creneaux(b);
    return creneaux(a).some(([debutA, finA]) => creneauxB.some(([debutB, finB]) =>
        [-MINUTES_SEMAINE, 0, MINUTES_SEMAINE].some((decalage) =>
            debutA < finB + decalage && debutB + decalage < finA)));
};

// Les horaires (18:00…) sont en heure locale. Décalage par rapport à UTC, en minutes :
// Kinshasa = +60 (UTC+1, sans heure d'été). À changer avec la variable d'environnement DECALAGE_HORAIRE_MINUTES.
const DECALAGE_MINUTES = Number(process.env.DECALAGE_HORAIRE_MINUTES ?? 60);

// Jour local d'un instant : "AAAA-MM-JJ"
const jourLocal = (date) => new Date(new Date(date).getTime() + DECALAGE_MINUTES * 60000).toISOString().slice(0, 10);

// Instant correspondant à un jour local "AAAA-MM-JJ" et une heure locale "HH:mm"
const instantLocal = (jour, heure = '00:00') => new Date(Date.parse(`${jour}T${heure}:00Z`) - DECALAGE_MINUTES * 60000);

// "AAAA-MM-JJ" + n jours
const decalerJour = (jour, n) => new Date(Date.parse(`${jour}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// Nom du jour de la semaine d'un jour local ("lundi"…)
const nomJour = (jour) => JOURS[(new Date(`${jour}T00:00:00Z`).getUTCDay() + 6) % 7];

// Service prévu par une affectation pour un jour local donné, ou null si le gardien ne travaille pas ce jour-là
// (jour non coché, ou en dehors de la période de l'affectation).
// Renvoie { jourService, debutPrevu, finPrevue } ; le service peut finir le lendemain (18:00 -> 06:00).
const servicePrevu = (affectation, jour) => {
    const jours = affectation.joursService?.length ? affectation.joursService : JOURS;
    if (!jours.includes(nomJour(jour))) return null;

    const heureDebut = affectation.heureDebut || '00:00';
    const heureFin = affectation.heureFin || '00:00';
    const debut = enMinutes(heureDebut);
    const fin = enMinutes(heureFin);
    const duree = fin > debut ? fin - debut : fin + MINUTES_JOUR - debut;

    const debutPrevu = instantLocal(jour, heureDebut);
    const finPrevue = new Date(debutPrevu.getTime() + duree * 60000);
    if (finPrevue <= affectation.dateDebut || debutPrevu >= affectation.dateFin) return null;
    return { jourService: jour, debutPrevu, finPrevue };
};

// Heure locale d'un instant : "HH:mm"
const heureLocale = (date) => new Date(new Date(date).getTime() + DECALAGE_MINUTES * 60000).toISOString().slice(11, 16);

module.exports = {
    JOURS, normaliserHeure, normaliserJours, horairesSeChevauchent,
    jourLocal, instantLocal, decalerJour, heureLocale, servicePrevu
};
