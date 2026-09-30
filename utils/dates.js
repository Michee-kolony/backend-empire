// Ajoute des mois à une date (le 31 janvier + 1 mois donne le 28/29 février)
const ajouterMois = (date, mois) => {
    const resultat = new Date(date);
    const jour = resultat.getUTCDate();
    resultat.setUTCDate(1);
    resultat.setUTCMonth(resultat.getUTCMonth() + mois);
    const dernierJour = new Date(Date.UTC(resultat.getUTCFullYear(), resultat.getUTCMonth() + 1, 0)).getUTCDate();
    resultat.setUTCDate(Math.min(jour, dernierJour));
    return resultat;
};

const ajouterJours = (date, jours) => new Date(new Date(date).getTime() + jours * 24 * 60 * 60 * 1000);

// Date de fin d'une période : unite = "jours" | "semaines" | "mois"
const ajouterDuree = (date, duree, unite) => {
    if (unite === 'jours') return ajouterJours(date, duree);
    if (unite === 'semaines') return ajouterJours(date, duree * 7);
    return ajouterMois(date, duree);
};

const formaterDate = (date) => new Date(date).toLocaleDateString('fr-FR', { timeZone: 'UTC' });

module.exports = { ajouterMois, ajouterDuree, formaterDate };
