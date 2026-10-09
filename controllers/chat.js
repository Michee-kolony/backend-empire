const mongoose = require('mongoose');
const Conversation = require('../models/conversation');
const Message = require('../models/message');
const Propriete = require('../models/propriete');
const Affectation = require('../models/affectation');
const Gardien = require('../models/gardien');
const Proprietaire = require('../models/proprietaire');
const Administrateur = require('../models/admin');
const { supprimerDeR2 } = require('../middleware/upload');
const socket = require('../utils/socket');

const ROLES_ADMIN = ['ADMIN', 'SUPER_ADMIN'];
const ROLES_PROPRIETAIRE = ['PROPRIETAIRE', 'GESTIONNAIRE', 'MANDATAIRE', 'LOCATAIRE'];

const MODELES = { Gardien, Proprietaire, Administrateur };
const CHAMPS_PROFIL = {
    Gardien: 'nom postnom prenom photoProfil matricule',
    Proprietaire: 'nom postnom prenom photo role actif',
    Administrateur: 'nom role actif'
};
const CHAMPS_PARTICIPANT = 'nom postnom prenom photo photoProfil role matricule';
// Valeurs acceptées pour "destinataireModele"
const NOMS_MODELES = {
    gardien: 'Gardien',
    proprietaire: 'Proprietaire',
    administrateur: 'Administrateur',
    admin: 'Administrateur'
};

const LIMITE_MESSAGES = 50;
const LIMITE_MAX = 200;

const erreur = (statut, message) => Object.assign(new Error(message), { statut });

const repondreErreur = (error, res) => {
    if (error.statut) return res.status(error.statut).json({ success: false, message: error.message });
    if (error.name === 'ValidationError' || error.name === 'CastError') {
        return res.status(400).json({ success: false, message: error.message });
    }
    return res.status(500).json({ success: false, message: error.message });
};

const verifierIdentifiant = (id, libelle = 'Identifiant') => {
    if (!mongoose.Types.ObjectId.isValid(id)) throw erreur(400, `${libelle} invalide`);
};

const idDe = (valeur) => String(valeur?._id ?? valeur);
const nomComplet = (doc) => [doc?.nom, doc?.postnom, doc?.prenom].filter(Boolean).join(' ');
const enCours = () => Affectation.filtreStatut('en cours');

// Utilisateur connecté : { id, role, modele }
const lireUtilisateur = (jeton) => {
    let modele = null;
    if (jeton?.role === 'GARDIEN') modele = 'Gardien';
    else if (ROLES_PROPRIETAIRE.includes(jeton?.role)) modele = 'Proprietaire';
    else if (ROLES_ADMIN.includes(jeton?.role)) modele = 'Administrateur';
    if (!modele) throw erreur(403, 'Accès refusé');
    return { id: String(jeton.id), role: jeton.role, modele };
};

const estAdmin = (u) => u.modele === 'Administrateur';
const estSuperAdmin = (u) => u.role === 'SUPER_ADMIN';

// Nom, rôle et photo d'un compte (null s'il n'existe plus ou est désactivé)
const chargerProfil = async (id, modele) => {
    if (!mongoose.Types.ObjectId.isValid(id)) return null;
    const doc = await MODELES[modele].findById(id).select(CHAMPS_PROFIL[modele]).lean();
    if (!doc || doc.actif === false) return null;
    return {
        id: String(doc._id),
        modele,
        nom: nomComplet(doc),
        role: modele === 'Gardien' ? 'GARDIEN' : doc.role,
        photo: doc.photoProfil || doc.photo || ''
    };
};

// Le gardien est-il en service sur une propriété de ce propriétaire ?
const gardienTravaillePour = async (gardienId, proprietaireId) => {
    const proprietes = await Propriete.distinct('_id', { proprietaire: proprietaireId });
    return Boolean(await Affectation.exists({ gardien: gardienId, propriete: { $in: proprietes }, ...enCours() }));
};

// Deux personnes peuvent-elles discuter en privé ?
// Admin <-> tout le monde ; gardien <-> propriétaire seulement si le gardien est en service chez lui.
const relationValide = async (a, b) => {
    if (a.modele === 'Administrateur' || b.modele === 'Administrateur') return true;
    const gardien = [a, b].find((p) => p.modele === 'Gardien');
    const proprietaire = [a, b].find((p) => p.modele === 'Proprietaire');
    if (!gardien || !proprietaire) return false;
    return gardienTravaillePour(gardien.id, proprietaire.id);
};

// Une discussion privée reste ouverte tant que la relation existe toujours avec chaque correspondant.
// Une fois fermée, elle reste dans la liste et consultable, mais plus personne ne peut y écrire.
const discussionOuverte = async (conversation, u) => {
    if (conversation.type !== 'directe') return true;
    for (const autre of conversation.participants.filter((p) => idDe(p.utilisateur) !== u.id)) {
        if (!autre.utilisateur || !(await relationValide(u, { id: idDe(autre.utilisateur), modele: autre.modele }))) return false;
    }
    return true;
};

// "membre" : peut lire et écrire ; "supervision" : super admin qui lit sans participer ; null : aucun accès
const acces = async (u, conversation) => {
    if (conversation.type === 'propriete') {
        if (estAdmin(u)) return 'membre';
        if (u.modele === 'Proprietaire') {
            const propriete = await Propriete.findById(idDe(conversation.propriete)).select('proprietaire');
            if (propriete && String(propriete.proprietaire) === u.id) return 'membre';
        }
        if (u.modele === 'Gardien' && await Affectation.exists({ gardien: u.id, propriete: idDe(conversation.propriete), ...enCours() })) {
            return 'membre';
        }
    } else if (conversation.participants.some((p) => idDe(p.utilisateur) === u.id)) {
        return 'membre';
    }
    return estSuperAdmin(u) ? 'supervision' : null;
};

const chargerConversation = async (id, u) => {
    verifierIdentifiant(id, 'Identifiant de conversation');
    const conversation = await Conversation.findById(id)
        .populate('propriete', 'nomReference commune quartier avenue numero photos proprietaire')
        .populate('participants.utilisateur', CHAMPS_PARTICIPANT);
    if (!conversation) throw erreur(404, 'Conversation introuvable');
    const niveau = await acces(u, conversation);
    if (!niveau) throw erreur(403, 'Vous ne faites pas partie de cette conversation');
    return { conversation, niveau };
};

// Salons Socket.IO de tous les membres actuels d'une conversation
const salonsDe = async (conversation) => {
    if (conversation.type === 'directe') {
        return conversation.participants.map((p) => socket.salonUtilisateur(idDe(p.utilisateur)));
    }
    const proprieteId = idDe(conversation.propriete);
    const [propriete, gardiens] = await Promise.all([
        Propriete.findById(proprieteId).select('proprietaire'),
        Affectation.distinct('gardien', { propriete: proprieteId, ...enCours() })
    ]);
    return [
        socket.SALON_ADMINS,
        ...(propriete ? [socket.salonUtilisateur(propriete.proprietaire)] : []),
        ...gardiens.map((id) => socket.salonUtilisateur(id))
    ];
};

// Version d'un message selon celui qui le lit : les membres ne voient ni l'historique des
// modifications ni le contenu des messages supprimés ; le super admin voit tout.
const formaterMessage = (message, supervision) => {
    const objet = message.toObject ? message.toObject() : { ...message };
    if (supervision) return objet;
    delete objet.historique;
    if (objet.supprime) {
        objet.contenu = '';
        objet.photos = [];
    }
    return objet;
};

// Prévient en temps réel tous les membres (et la supervision) d'un changement sur un message
const diffuserMessage = async (conversation, evenement, message) => {
    const salons = await salonsDe(conversation);
    socket.emettre(
        salons,
        evenement,
        { conversation: String(conversation._id), message: formaterMessage(message, false) },
        { conversation: String(conversation._id), message: formaterMessage(message, true) }
    );
};

const apercu = (message) => {
    if (message.supprime) return 'Message supprimé';
    if (message.contenu) return message.contenu.slice(0, 120);
    return message.photos.length > 1 ? `📷 ${message.photos.length} photos` : '📷 Photo';
};

// Met à jour l'aperçu de la conversation si ce message est le dernier
const majApercu = async (conversation, message) => {
    const dernier = await Message.findOne({ conversation: conversation._id }).sort({ createdAt: -1 }).select('_id');
    if (dernier && String(dernier._id) === String(message._id)) {
        await Conversation.updateOne({ _id: conversation._id }, { $set: { 'dernierMessage.contenu': apercu(message) } });
    }
};

const marquerLu = async (conversationId, utilisateurId, date = new Date()) => {
    const resultat = await Conversation.updateOne(
        { _id: conversationId, 'lectures.utilisateur': utilisateurId },
        { $set: { 'lectures.$.date': date } }
    );
    if (resultat.matchedCount === 0) {
        await Conversation.updateOne(
            { _id: conversationId, 'lectures.utilisateur': { $ne: utilisateurId } },
            { $push: { lectures: { utilisateur: utilisateurId, date } } }
        );
    }
    return date;
};

const trouverOuCreer = async (filtre, donnees) => {
    const existante = await Conversation.findOne(filtre);
    if (existante) return existante;
    try {
        return await Conversation.create(donnees);
    } catch (error) {
        if (error.code === 11000) return Conversation.findOne(filtre); // créée au même moment par quelqu'un d'autre
        throw error;
    }
};

const conversationPropriete = (proprieteId, u) => trouverOuCreer(
    { type: 'propriete', propriete: proprieteId },
    { type: 'propriete', propriete: proprieteId, participants: [], creePar: u.id, creeParModele: u.modele }
);

// Titre, photo, membres et non lus pour l'affichage
const formaterConversation = async (conversation, u, niveau) => {
    const objet = conversation.toObject();
    objet.acces = niveau;

    if (conversation.type === 'propriete') {
        objet.titre = conversation.propriete?.nomReference ?? 'Propriété';
        objet.photo = conversation.propriete?.photos?.[0] ?? '';
    } else {
        const personnes = objet.participants.map((p) => ({
            id: idDe(p.utilisateur),
            modele: p.modele,
            nom: nomComplet(p.utilisateur) || 'Compte supprimé',
            role: p.modele === 'Gardien' ? 'GARDIEN' : p.utilisateur?.role,
            photo: p.utilisateur?.photoProfil || p.utilisateur?.photo || ''
        }));
        objet.participants = personnes;
        const autres = personnes.filter((p) => p.id !== u.id);
        objet.titre = autres.map((p) => p.nom).join(' ↔ ');
        objet.photo = autres.length === 1 ? autres[0].photo : '';
        if (niveau === 'membre') objet.interlocuteur = autres[0] ?? null;
    }

    // false : la supervision, ou une discussion privée gardée en lecture seule
    // (ex : le gardien n'est plus en service chez ce propriétaire, l'historique reste consultable)
    objet.peutEcrire = niveau === 'membre' && await discussionOuverte(conversation, u);

    if (niveau === 'membre') {
        const lecture = conversation.lectures.find((l) => String(l.utilisateur) === u.id);
        objet.nonLus = await Message.countDocuments({
            conversation: conversation._id,
            supprime: false,
            auteur: { $ne: u.id },
            ...(lecture ? { createdAt: { $gt: lecture.date } } : {})
        });
    } else {
        objet.nonLus = 0;
    }
    return objet;
};

const trierConversations = { 'dernierMessage.date': -1, updatedAt: -1 };

// ---------- Exposé au socket ----------

// "En train d'écrire" : relayé aux autres membres (pas d'enregistrement)
exports.signalerEcriture = async (jeton, conversationId) => {
    const u = lireUtilisateur(jeton);
    const { conversation, niveau } = await chargerConversation(conversationId, u);
    if (niveau !== 'membre') return;
    const profil = await chargerProfil(u.id, u.modele);
    if (!profil) return;
    const salons = await salonsDe(conversation);
    socket.emettreSansSupervision(salons, 'chat:ecrit', {
        conversation: String(conversation._id),
        utilisateur: { id: profil.id, nom: profil.nom, modele: profil.modele }
    }, u.id);
};

// ---------- Routes ----------

// Personnes avec qui l'utilisateur peut ouvrir une discussion privée
exports.contacts = async (req, res) => {
    try {
        const u = lireUtilisateur(req.admin);
        const contacts = [];

        if (u.modele === 'Gardien') {
            const proprietes = await Propriete.find({
                _id: { $in: await Affectation.distinct('propriete', { gardien: u.id, ...enCours() }) }
            }).select('nomReference proprietaire').populate('proprietaire', 'nom postnom prenom photo role actif');
            for (const propriete of proprietes) {
                const p = propriete.proprietaire;
                if (!p || p.actif === false) continue;
                contacts.push({
                    id: String(p._id), modele: 'Proprietaire', nom: nomComplet(p), role: p.role,
                    photo: p.photo || '', propriete: { id: String(propriete._id), nomReference: propriete.nomReference }
                });
            }
        } else if (u.modele === 'Proprietaire') {
            const proprietes = await Propriete.find({ proprietaire: u.id }).select('nomReference');
            const affectations = await Affectation.find({ propriete: { $in: proprietes.map((p) => p._id) }, ...enCours() })
                .select('gardien propriete role')
                .populate('gardien', 'nom postnom prenom photoProfil matricule');
            for (const a of affectations) {
                if (!a.gardien) continue;
                const propriete = proprietes.find((p) => String(p._id) === String(a.propriete));
                contacts.push({
                    id: String(a.gardien._id), modele: 'Gardien', nom: nomComplet(a.gardien), role: 'GARDIEN',
                    photo: a.gardien.photoProfil || '', matricule: a.gardien.matricule, roleAffectation: a.role,
                    propriete: { id: String(a.propriete), nomReference: propriete?.nomReference ?? '' }
                });
            }
        }

        const admins = await Administrateur.find({ actif: true, _id: { $ne: u.id } }).select('nom role');
        for (const admin of admins) {
            contacts.push({ id: String(admin._id), modele: 'Administrateur', nom: admin.nom, role: admin.role, photo: '' });
        }

        return res.status(200).json({ success: true, total: contacts.length, contacts });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// Mes conversations (les discussions de mes propriétés sont créées automatiquement)
exports.mesConversations = async (req, res) => {
    try {
        const u = lireUtilisateur(req.admin);
        const conditions = [{ type: 'directe', 'participants.utilisateur': u.id }];

        if (estAdmin(u)) {
            conditions.push({ type: 'propriete' });
        } else {
            const proprietes = u.modele === 'Gardien'
                ? await Affectation.distinct('propriete', { gardien: u.id, ...enCours() })
                : await Propriete.distinct('_id', { proprietaire: u.id });
            await Promise.all(proprietes.map((id) => conversationPropriete(id, u)));
            conditions.push({ type: 'propriete', propriete: { $in: proprietes } });
        }

        const conversations = await Conversation.find({ $or: conditions })
            .sort(trierConversations)
            .populate('propriete', 'nomReference commune quartier avenue numero photos proprietaire')
            .populate('participants.utilisateur', CHAMPS_PARTICIPANT);

        const resultat = await Promise.all(conversations.map((c) => formaterConversation(c, u, 'membre')));
        const nonLus = resultat.reduce((total, c) => total + c.nonLus, 0);
        return res.status(200).json({ success: true, total: resultat.length, nonLus, conversations: resultat });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// Ouvrir (ou retrouver) une conversation
// Body : { propriete } pour la discussion d'une propriété
//     ou { destinataire, destinataireModele: gardien | proprietaire | admin } pour une discussion privée
exports.ouvrir = async (req, res) => {
    try {
        const u = lireUtilisateur(req.admin);
        const { propriete: proprieteId, destinataire, destinataireModele } = req.body;
        let conversation;

        if (proprieteId) {
            verifierIdentifiant(proprieteId, 'Identifiant de propriété');
            if (!(await Propriete.exists({ _id: proprieteId }))) throw erreur(404, 'Propriété introuvable');
            const niveau = await acces(u, { type: 'propriete', propriete: proprieteId });
            if (niveau !== 'membre') throw erreur(403, 'Vous ne pouvez pas rejoindre la discussion de cette propriété');
            conversation = await conversationPropriete(proprieteId, u);
        } else if (destinataire) {
            const modele = NOMS_MODELES[String(destinataireModele ?? '').toLowerCase().trim()];
            if (!modele) throw erreur(400, 'destinataireModele invalide : gardien, proprietaire ou admin');
            verifierIdentifiant(destinataire, 'Identifiant du destinataire');
            if (String(destinataire) === u.id) throw erreur(400, 'Vous ne pouvez pas discuter avec vous-même');

            const autre = await chargerProfil(destinataire, modele);
            if (!autre) throw erreur(404, 'Destinataire introuvable');
            if (!(await relationValide(u, autre))) {
                throw erreur(403, 'Vous ne pouvez discuter qu\'avec les personnes liées à vos propriétés ou avec l\'administration');
            }

            const cleDirecte = Conversation.cleDirecte(u.id, autre.id);
            conversation = await trouverOuCreer({ type: 'directe', cleDirecte }, {
                type: 'directe',
                cleDirecte,
                participants: [{ utilisateur: u.id, modele: u.modele }, { utilisateur: autre.id, modele: autre.modele }],
                creePar: u.id,
                creeParModele: u.modele
            });
        } else {
            throw erreur(400, 'Précisez "propriete" ou "destinataire"');
        }

        const { conversation: complete, niveau } = await chargerConversation(conversation._id, u);
        return res.status(200).json({ success: true, conversation: await formaterConversation(complete, u, niveau) });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// Détail d'une conversation, avec ses membres actuels
exports.getConversation = async (req, res) => {
    try {
        const u = lireUtilisateur(req.admin);
        const { conversation, niveau } = await chargerConversation(req.params.id, u);
        const resultat = await formaterConversation(conversation, u, niveau);

        if (conversation.type === 'propriete') {
            const proprieteId = idDe(conversation.propriete);
            const [propriete, affectations] = await Promise.all([
                Propriete.findById(proprieteId).select('proprietaire').populate('proprietaire', 'nom postnom prenom photo role'),
                Affectation.find({ propriete: proprieteId, ...enCours() }).select('gardien role')
                    .populate('gardien', 'nom postnom prenom photoProfil matricule')
            ]);
            resultat.membres = [
                ...(propriete?.proprietaire ? [{
                    id: String(propriete.proprietaire._id), modele: 'Proprietaire', nom: nomComplet(propriete.proprietaire),
                    role: propriete.proprietaire.role, photo: propriete.proprietaire.photo || ''
                }] : []),
                ...affectations.filter((a) => a.gardien).map((a) => ({
                    id: String(a.gardien._id), modele: 'Gardien', nom: nomComplet(a.gardien), role: 'GARDIEN',
                    photo: a.gardien.photoProfil || '', matricule: a.gardien.matricule, roleAffectation: a.role
                })),
                { id: null, modele: 'Administrateur', nom: 'Administration Empire', role: 'ADMIN', photo: '' }
            ];
        }

        return res.status(200).json({ success: true, conversation: resultat });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// Messages d'une conversation, du plus ancien au plus récent.
// Query : avant (date ISO, pour charger les messages plus anciens), limite (50 par défaut)
// Marque la conversation comme lue pour un membre (pas pour la supervision).
exports.getMessages = async (req, res) => {
    try {
        const u = lireUtilisateur(req.admin);
        const { conversation, niveau } = await chargerConversation(req.params.id, u);

        const limite = Math.min(Math.max(parseInt(req.query.limite, 10) || LIMITE_MESSAGES, 1), LIMITE_MAX);
        const filtre = { conversation: conversation._id };
        if (req.query.avant) {
            const avant = new Date(req.query.avant);
            if (Number.isNaN(avant.getTime())) throw erreur(400, 'Date "avant" invalide');
            filtre.createdAt = { $lt: avant };
        }

        const messages = await Message.find(filtre).sort({ createdAt: -1 }).limit(limite + 1);
        const plusAnciens = messages.length > limite;
        const page = messages.slice(0, limite).reverse();

        if (niveau === 'membre' && !req.query.avant) {
            const date = await marquerLu(conversation._id, u.id);
            socket.emettreSansSupervision(await salonsDe(conversation), 'conversation:lu', {
                conversation: String(conversation._id), utilisateur: u.id, date
            }, u.id);
        }

        return res.status(200).json({
            success: true,
            acces: niveau,
            plusAnciens,
            delaiModificationMinutes: Message.DELAI_MODIFICATION_MINUTES,
            messages: page.map((m) => formaterMessage(m, estSuperAdmin(u)))
        });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// Envoyer un message — multipart/form-data
// Body : contenu (facultatif si au moins une photo) ; Fichiers : "photos" (0 à 5 images)
exports.envoyer = async (req, res) => {
    const photos = req.fichiers?.photos ?? [];
    try {
        const u = lireUtilisateur(req.admin);
        const { conversation, niveau } = await chargerConversation(req.params.id, u);
        if (niveau !== 'membre') throw erreur(403, 'La supervision permet de lire la conversation, pas d\'y écrire');

        const profil = await chargerProfil(u.id, u.modele);
        if (!profil) throw erreur(401, 'Compte introuvable ou désactivé');

        if (!(await discussionOuverte(conversation, u))) {
            throw erreur(403, 'Cette discussion est fermée : vous n\'êtes plus lié à ce correspondant');
        }

        const message = await Message.create({
            conversation: conversation._id,
            auteur: u.id,
            auteurModele: u.modele,
            auteurNom: profil.nom,
            auteurRole: profil.role,
            auteurPhoto: profil.photo,
            contenu: req.body.contenu ?? '',
            photos
        });

        await Conversation.updateOne({ _id: conversation._id }, {
            $set: { dernierMessage: { contenu: apercu(message), auteurNom: profil.nom, date: message.createdAt } }
        });
        await marquerLu(conversation._id, u.id, message.createdAt);
        await diffuserMessage(conversation, 'message:nouveau', message);

        return res.status(201).json({ success: true, message: formaterMessage(message, estSuperAdmin(u)) });
    } catch (error) {
        supprimerDeR2(photos).catch(() => {});
        return repondreErreur(error, res);
    }
};

// Marquer une conversation comme lue
exports.marquerLu = async (req, res) => {
    try {
        const u = lireUtilisateur(req.admin);
        const { conversation, niveau } = await chargerConversation(req.params.id, u);
        if (niveau !== 'membre') return res.status(200).json({ success: true });
        const date = await marquerLu(conversation._id, u.id);
        socket.emettreSansSupervision(await salonsDe(conversation), 'conversation:lu', {
            conversation: String(conversation._id), utilisateur: u.id, date
        }, u.id);
        return res.status(200).json({ success: true, date });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// Message de l'utilisateur connecté, encore modifiable
const chargerMonMessage = async (req, u) => {
    verifierIdentifiant(req.params.id, 'Identifiant de message');
    const message = await Message.findById(req.params.id);
    if (!message) throw erreur(404, 'Message introuvable');
    if (String(message.auteur) !== u.id) throw erreur(403, 'Vous ne pouvez modifier que vos propres messages');
    if (message.supprime) throw erreur(400, 'Ce message a été supprimé');
    if (Date.now() > message.modifiableJusqua.getTime()) {
        throw erreur(403, `Un message ne peut plus être modifié ni supprimé après ${Message.DELAI_MODIFICATION_MINUTES} minutes`);
    }
    const { conversation, niveau } = await chargerConversation(message.conversation, u);
    if (niveau !== 'membre') throw erreur(403, 'Vous ne faites plus partie de cette conversation');
    return { message, conversation };
};

// Corriger un message mal envoyé (auteur uniquement, dans le délai). Body : contenu
// L'ancienne version est conservée dans l'historique (visible par le super admin).
exports.modifier = async (req, res) => {
    try {
        const u = lireUtilisateur(req.admin);
        if (req.body.contenu === undefined) throw erreur(400, 'Le nouveau contenu est obligatoire');
        const { message, conversation } = await chargerMonMessage(req, u);

        const contenu = String(req.body.contenu).trim();
        if (contenu === message.contenu) throw erreur(400, 'Le message est identique');

        message.historique.push({ contenu: message.contenu, remplaceLe: new Date() });
        message.contenu = contenu;
        message.modifie = true;
        message.modifieLe = new Date();
        await message.save();

        await majApercu(conversation, message);
        await diffuserMessage(conversation, 'message:modifie', message);
        return res.status(200).json({ success: true, message: formaterMessage(message, estSuperAdmin(u)) });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// Supprimer un message mal envoyé (auteur uniquement, dans le délai).
// Il disparaît pour les participants mais reste lisible par le super admin, photos comprises.
exports.supprimer = async (req, res) => {
    try {
        const u = lireUtilisateur(req.admin);
        const { message, conversation } = await chargerMonMessage(req, u);

        message.supprime = true;
        message.supprimeLe = new Date();
        await message.save();

        await majApercu(conversation, message);
        await diffuserMessage(conversation, 'message:supprime', message);
        return res.status(200).json({ success: true, message: 'Message supprimé' });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// ---------- Supervision (super admin) ----------

// Toutes les conversations. Query : type, propriete, participant (id d'un gardien / propriétaire / admin), page, limite
exports.supervisionConversations = async (req, res) => {
    try {
        const u = lireUtilisateur(req.admin);
        const filtre = {};
        if (req.query.type !== undefined) {
            if (!Conversation.TYPES[req.query.type]) throw erreur(400, 'Type invalide : propriete ou directe');
            filtre.type = req.query.type;
        }
        if (req.query.propriete !== undefined) {
            verifierIdentifiant(req.query.propriete, 'Identifiant de propriété');
            filtre.propriete = req.query.propriete;
        }
        if (req.query.participant !== undefined) {
            verifierIdentifiant(req.query.participant, 'Identifiant du participant');
            const ecrites = await Message.distinct('conversation', { auteur: req.query.participant });
            filtre.$or = [{ 'participants.utilisateur': req.query.participant }, { _id: { $in: ecrites } }];
        }

        const limite = Math.min(Math.max(parseInt(req.query.limite, 10) || LIMITE_MESSAGES, 1), LIMITE_MAX);
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);

        const [total, conversations] = await Promise.all([
            Conversation.countDocuments(filtre),
            Conversation.find(filtre)
                .sort(trierConversations)
                .skip((page - 1) * limite)
                .limit(limite)
                .populate('propriete', 'nomReference commune quartier avenue numero photos proprietaire')
                .populate('participants.utilisateur', CHAMPS_PARTICIPANT)
        ]);

        const resultat = await Promise.all(conversations.map(async (c) => {
            const objet = await formaterConversation(c, u, await acces(u, c));
            const [nombreMessages, modifies, supprimes] = await Promise.all([
                Message.countDocuments({ conversation: c._id }),
                Message.countDocuments({ conversation: c._id, modifie: true }),
                Message.countDocuments({ conversation: c._id, supprime: true })
            ]);
            objet.statistiques = { messages: nombreMessages, modifies, supprimes };
            return objet;
        }));

        return res.status(200).json({ success: true, total, page, limite, conversations: resultat });
    } catch (error) {
        return repondreErreur(error, res);
    }
};

// Recherche dans tous les messages (version complète).
// Query : q (texte), auteur, conversation, modifie=true, supprime=true, du, au (AAAA-MM-JJ), page, limite
exports.supervisionMessages = async (req, res) => {
    try {
        const filtre = {};
        if (req.query.q) {
            const motif = String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            filtre.$or = [{ contenu: { $regex: motif, $options: 'i' } }, { 'historique.contenu': { $regex: motif, $options: 'i' } }];
        }
        for (const champ of ['auteur', 'conversation']) {
            if (req.query[champ] !== undefined) {
                verifierIdentifiant(req.query[champ], `Identifiant ${champ}`);
                filtre[champ] = req.query[champ];
            }
        }
        if (req.query.modifie === 'true') filtre.modifie = true;
        if (req.query.supprime === 'true') filtre.supprime = true;
        if (req.query.du || req.query.au) {
            filtre.createdAt = {};
            if (req.query.du) filtre.createdAt.$gte = new Date(req.query.du);
            if (req.query.au) filtre.createdAt.$lt = new Date(new Date(req.query.au).getTime() + 86400000);
            if (Object.values(filtre.createdAt).some((d) => Number.isNaN(d.getTime()))) {
                throw erreur(400, 'Dates "du" et "au" au format AAAA-MM-JJ');
            }
        }

        const limite = Math.min(Math.max(parseInt(req.query.limite, 10) || LIMITE_MESSAGES, 1), LIMITE_MAX);
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);

        const [total, messages] = await Promise.all([
            Message.countDocuments(filtre),
            Message.find(filtre).sort({ createdAt: -1 }).skip((page - 1) * limite).limit(limite)
                .populate({ path: 'conversation', select: 'type propriete participants', populate: { path: 'propriete', select: 'nomReference' } })
        ]);

        return res.status(200).json({ success: true, total, page, limite, messages: messages.map((m) => formaterMessage(m, true)) });
    } catch (error) {
        return repondreErreur(error, res);
    }
};
