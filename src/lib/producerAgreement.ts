export type AgreementKind = 'non-exclusive' | 'exclusive';

export interface ProducerAgreementInput {
  kind: AgreementKind;
  effectiveDate: string;
  producerLegalName: string;
  producerStageName: string;
  producerAddress: string;
  producerEmail: string;
  artistLegalName: string;
  artistStageName: string;
  artistAddress: string;
  artistEmail: string;
  beatTitle: string;
  beatId: string;
  fee: string;
  currency: string;
  deliverables: string;
  producerCompositionShare: string;
  producerMasterRoyalty: string;
  containsSamples: boolean;
  sampleDisclosure: string;
  governingState: string;
  governingCounty: string;
  termYears: string;
  copies: string;
  audioStreams: string;
  videoStreams: string;
  musicVideos: string;
  radioStations: string;
  paidPerformances: boolean;
  allowSync: boolean;
  priorLicenses: boolean;
  priorLicenseNotice: string;
}

const required = (value: string, label: string, errors: string[]) => {
  if (!value.trim()) errors.push(`${label} is required.`);
};

const percentage = (value: string, label: string, errors: string[]) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) errors.push(`${label} must be between 0 and 100.`);
};

const positive = (value: string, label: string, errors: string[], allowUnlimited = false) => {
  if (allowUnlimited && value.trim().toLowerCase() === 'unlimited') return;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) errors.push(`${label} must be zero or greater${allowUnlimited ? ', or “unlimited”' : ''}.`);
};

export function validateProducerAgreement(input: ProducerAgreementInput): string[] {
  const errors: string[] = [];
  required(input.effectiveDate, 'Effective date', errors);
  required(input.producerLegalName, 'Producer legal name', errors);
  required(input.producerAddress, 'Producer address', errors);
  required(input.producerEmail, 'Producer email', errors);
  required(input.artistLegalName, 'Artist legal name', errors);
  required(input.artistAddress, 'Artist address', errors);
  required(input.artistEmail, 'Artist email', errors);
  required(input.beatTitle, 'Beat title', errors);
  required(input.fee, 'License fee', errors);
  required(input.currency, 'Currency', errors);
  required(input.deliverables, 'Deliverables', errors);
  required(input.governingState, 'Governing state', errors);
  required(input.governingCounty, 'Governing county', errors);
  positive(input.fee, 'License fee', errors);
  percentage(input.producerCompositionShare, 'Producer composition share', errors);
  percentage(input.producerMasterRoyalty, 'Producer master royalty', errors);
  if (input.containsSamples) required(input.sampleDisclosure, 'Sample disclosure', errors);
  if (input.kind === 'non-exclusive') {
    positive(input.termYears, 'Term', errors);
    if (Number(input.termYears) <= 0) errors.push('Term must be greater than zero.');
    positive(input.copies, 'Distribution limit', errors, true);
    positive(input.audioStreams, 'Audio-stream limit', errors, true);
    positive(input.videoStreams, 'Video-stream limit', errors, true);
    positive(input.musicVideos, 'Music-video limit', errors, true);
    positive(input.radioStations, 'Radio-station limit', errors, true);
  }
  if (input.kind === 'exclusive' && input.priorLicenses) required(input.priorLicenseNotice, 'Outstanding-license notice', errors);
  return [...new Set(errors)];
}

const displayName = (legalName: string, stageName: string) => stageName.trim() ? `${legalName.trim()} professionally known as “${stageName.trim()}”` : legalName.trim();
const money = (currency: string, fee: string) => `${currency.trim().toUpperCase()} ${Number(fee).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const limit = (value: string) => value.trim().toLowerCase() === 'unlimited' ? 'unlimited' : Number(value).toLocaleString('en-US');
const royaltyClause = (input: ProducerAgreementInput) => Number(input.producerMasterRoyalty) > 0
  ? `Producer is entitled to ${input.producerMasterRoyalty}% of Gross Master Receipts from the New Master (the “Producer Royalty”), calculated from the first dollar actually received and not subject to recoupment of the License Fee. “Gross Master Receipts” means all money actually received by or credited to Artist from exploitation of the New Master, less only refunds, sales or value-added taxes, and third-party distributor or payment-processing fees directly attributable to that receipt; no overhead, recording cost, marketing cost, legal fee, or cross-collateralized expense may be deducted. Artist shall provide statements and payment within forty-five (45) days after each calendar quarter in which receipts are collected. Producer may, once per calendar year and on fifteen (15) business days’ notice, audit the relevant books for statements issued during the prior two (2) years. If an audit finds an underpayment greater than five percent (5%), Artist shall promptly pay the shortage and reasonable audit cost.`
  : 'No continuing master royalty is due to Producer. The License Fee is the complete master-use compensation, but it does not buy, reduce, or waive Producer’s composition ownership or publishing income described below.';

export function buildProducerAgreement(input: ProducerAgreementInput): string {
  const errors = validateProducerAgreement(input);
  if (errors.length) throw new Error(errors.join('\n'));

  const producer = displayName(input.producerLegalName, input.producerStageName);
  const artist = displayName(input.artistLegalName, input.artistStageName);
  const agreementName = input.kind === 'exclusive' ? 'EXCLUSIVE BEAT LICENSE AGREEMENT' : 'NON-EXCLUSIVE BEAT LICENSE AGREEMENT';
  const grant = input.kind === 'exclusive'
    ? `Subject to timely payment and Artist’s continuing compliance, Producer grants Artist the exclusive, worldwide license for the full copyright term to incorporate the Beat into one (1) original song (the “New Song”), to create one (1) principal sound recording of the New Song (the “New Master”), and to reproduce, distribute, sell, stream, publicly perform, communicate to the public, advertise, monetize, and otherwise exploit the New Master in all media now known or later developed. Beginning when cleared funds are received, Producer shall not grant any new license of the Beat for a competing song or master. This is an exclusive license, not an assignment of Producer’s ownership in the Beat or Producer’s share of the New Song composition.`
    : `Subject to timely payment and Artist’s continuing compliance, Producer grants Artist a limited, non-exclusive, non-transferable, worldwide license during the Term to incorporate the Beat into one (1) original song (the “New Song”), to create one (1) principal sound recording of the New Song (the “New Master”), and to exploit only that New Master within the limits in Section 4. Producer retains the right to use the Beat and to grant the same or similar rights to other licensees.`;
  const priorLicenses = input.kind === 'exclusive'
    ? input.priorLicenses
      ? `Artist acknowledges that the following licenses or authorized uses were granted before this Agreement and remain valid according to their original terms: ${input.priorLicenseNotice.trim()} (the “Outstanding Licenses”). Exclusivity begins prospectively on the Effective Date after payment. Artist shall not interfere with an Outstanding License, and any Content ID registration must allowlist the works identified in the Outstanding Licenses.`
      : 'Producer represents that no outstanding third-party beat license has been granted for the Beat. If that representation is inaccurate, Producer must promptly refund the License Fee at Artist’s option or obtain a written release sufficient to deliver the promised exclusivity.'
    : 'Because this license is non-exclusive, Artist acknowledges that other recordings may lawfully use the same Beat. Artist receives no right to block, remove, demonetize, or otherwise interfere with another authorized licensee.';
  const permittedUse = input.kind === 'exclusive'
    ? `There is no numerical cap on authorized copies, downloads, audio streams, video streams, music videos, radio stations, or paid live performances. Artist may authorize synchronization of the New Master in audiovisual productions, subject to Producer’s composition share and the accounting obligations in this Agreement.`
    : `The license permits up to ${limit(input.copies)} paid or free copies/downloads; ${limit(input.audioStreams)} monetized or non-monetized audio streams; ${limit(input.videoStreams)} monetized or non-monetized video streams; ${limit(input.musicVideos)} music video(s); and airplay on up to ${limit(input.radioStations)} terrestrial or satellite radio station(s). Paid live performances are ${input.paidPerformances ? 'permitted' : 'not permitted'}. Synchronization of the New Master in film, television, advertising, games, apps, or other third-party audiovisual productions is ${input.allowSync ? 'permitted, subject to the composition split and all other terms of this Agreement' : 'not included and requires Producer’s separate written approval'}. Exceeding a limit requires a written upgrade signed by Producer before further exploitation.`;
  const term = input.kind === 'exclusive'
    ? 'The grant continues for the full duration of copyright in the Beat and New Song, unless terminated for an uncured material breach under Section 14.'
    : `The term is ${input.termYears} year(s) beginning on the Effective Date (the “Term”). There is no automatic renewal. Continued exploitation after the Term requires a new written license.`;
  const contentId = input.kind === 'exclusive'
    ? 'Artist may register only the New Master with a digital fingerprinting or content-identification service after accounting for every Outstanding License. Artist may not claim ownership of the standalone Beat, and shall promptly release any claim against Producer’s own material or an authorized prior use.'
    : 'Artist shall not register the Beat or New Master with YouTube Content ID, Meta Rights Manager, Audible Magic, a distributor fingerprinting system, or any similar service that could claim or block another authorized use of the Beat. Artist may use ordinary copyright notices that accurately identify Artist’s rights in the New Master.';
  const sampleText = input.containsSamples
    ? `Producer discloses the following third-party material in the Beat: ${input.sampleDisclosure.trim()} Producer is responsible for obtaining and paying for clearance of third-party material Producer placed in the Beat unless the parties sign a different allocation. Artist is responsible for material Artist or Artist’s collaborators add to the New Song or New Master. Neither party shall commercially release the affected work until required clearances are in writing.`
    : 'Producer represents that the Beat is original to Producer and contains no undisclosed sample, interpolation, loop, performance, or other third-party material requiring permission. Artist is responsible for clearing all lyrics, vocals, performances, samples, interpolations, or other material added by Artist or Artist’s collaborators.';
  const feeText = `${money(input.currency, input.fee)} (the “License Fee”). The License Fee is due in cleared funds before delivery of untagged files or exploitation of the Beat. No license becomes effective until Producer receives the full License Fee. Except for Producer’s uncured breach or a failed exclusivity representation, the License Fee is non-refundable.`;
  const split = Number(input.producerCompositionShare);

  return `${agreementName}

This Beat License Agreement (the “Agreement”) is entered into as of ${input.effectiveDate} (the “Effective Date”) between ${producer}, with an address at ${input.producerAddress.trim()} and email ${input.producerEmail.trim()} (“Producer”), and ${artist}, with an address at ${input.artistAddress.trim()} and email ${input.artistEmail.trim()} (“Artist”). Producer and Artist are each a “Party” and together the “Parties.”

BEAT: “${input.beatTitle.trim()}”${input.beatId.trim() ? ` (catalog/file ID: ${input.beatId.trim()})` : ''}

1. PURPOSE AND DEFINITIONS
Producer created and controls the instrumental musical composition and sound-recording elements identified above (collectively, the “Beat”). “New Song” means the musical composition formed by combining the Beat with lyrics, melody, or other original material authorized by Artist. “New Master” means the final sound recording embodying the New Song. The Beat, New Song, and New Master are separate rights and are treated separately in this Agreement.

2. ENGAGEMENT AND GRANT
${grant}

3. LICENSE FEE AND EFFECTIVE PAYMENT
Artist shall pay Producer ${feeText}

4. TERM, TERRITORY, AND PERMITTED EXPLOITATION
${term} The territory is worldwide. ${permittedUse}

5. OWNERSHIP OF BEAT, NEW SONG, AND NEW MASTER
Producer retains all ownership in the standalone Beat and all rights not expressly granted. Artist owns Artist’s newly recorded performances and, subject to this Agreement, the New Master as a whole. Artist may not sell, sublicense, distribute, upload, or monetize the Beat by itself; place it in a sample pack, beat pack, production library, or stock-music service; authorize another artist to record over it; or create more than one New Song or principal New Master from it. Alternate mixes, clean versions, radio edits, remasters, and short-form excerpts of the same New Master are permitted and are not additional songs.

6. COMPOSITION AND PUBLISHING
The Parties agree that Producer owns ${split}% and Artist and Artist’s other writers collectively own ${100 - split}% of the copyright in the New Song composition. Each Party retains and administers its own share, including its writer’s share and publisher’s share, and shall register accurate splits with its performing-rights organization, mechanical-rights organization, publisher, or administrator. Artist is responsible for obtaining signed split confirmations from any additional writer without reducing Producer’s ${split}% unless Producer agrees in a signed writing. Nothing in the License Fee buys out Producer’s composition share, mechanical royalties, performance royalties, or synchronization income attributable to that share.

7. MASTER ROYALTY, STATEMENTS, AND AUDIT
${royaltyClause(input)}

8. DELIVERY AND ACCEPTANCE
After cleared payment, Producer shall deliver: ${input.deliverables.trim()}. Artist shall inspect the files and report a technical defect within seven (7) calendar days. Producer shall correct a verified delivery defect within a reasonable time. Creative preference is not a technical defect, and silence after seven (7) days constitutes acceptance.

9. CREDIT
Artist shall provide the credit “Produced by ${input.producerStageName.trim() || input.producerLegalName.trim()}” in distributor metadata wherever a producer-credit field exists, in the description or credits of official video uploads, and in commercially reasonable liner notes and promotional credits. An accidental omission is not a material breach if Artist corrects editable metadata within ten (10) business days after written notice.

10. PRIOR AND COMPETING LICENSES
${priorLicenses}

11. CONTENT IDENTIFICATION AND COPYRIGHT CLAIMS
${contentId}

12. SAMPLES, LOOPS, AND THIRD-PARTY MATERIAL
${sampleText}

13. REPRESENTATIONS AND WARRANTIES
Each Party represents that it has legal capacity and authority to sign and perform this Agreement. Producer represents that Producer controls the rights expressly licensed and has not knowingly made a conflicting grant, subject to any disclosed Outstanding Licenses. Artist represents that Artist will not exploit the Beat beyond this Agreement, that Artist controls or will clear all Artist-added material, and that the New Song and New Master will not defame, unlawfully invade privacy, or infringe another person’s rights. Neither Party makes a promise about commercial success, placement, earnings, or audience performance.

14. DEFAULT, CURE, SUSPENSION, AND TERMINATION
A payment default has five (5) business days to cure after written notice. Any other material breach has fifteen (15) business days to cure after written notice if curable. During an uncured breach, Producer may suspend the license. If the breach remains uncured, the non-breaching Party may terminate this Agreement by written notice. On termination for Artist’s breach, Artist must stop new distribution and monetization, request takedown of controllable uploads within ten (10) business days, and pay all accrued amounts; previously manufactured physical units may not be newly sold. Termination does not erase accrued payment, accounting, indemnity, audit, ownership, or confidentiality obligations. Producer may not terminate merely to obtain a better offer.

15. INDEMNITY AND LIABILITY
Each Party shall defend, indemnify, and hold the other harmless from third-party claims, damages, judgments, and reasonable outside legal fees arising from that Party’s breach of its representations, warranties, or obligations. The party seeking indemnity must promptly notify the other and allow reasonable control of the defense; no settlement may admit fault or impose a non-monetary obligation on the protected party without consent. Neither Party is liable for indirect or punitive damages, except for infringement, fraud, willful misconduct, indemnity obligations, or unpaid amounts.

16. REMEDIES
Unauthorized use of music rights may cause harm that money alone cannot repair. Subject to applicable law, either Party may seek an injunction for an actual or threatened material infringement of its rights, in addition to damages and other available remedies. Before filing suit, the Parties shall attempt in good faith for ten (10) business days to resolve the dispute, except when emergency relief is reasonably necessary.

17. ASSIGNMENT AND RELATIONSHIP
Artist may assign this Agreement together with the New Master to a label, distributor, publisher, successor, or purchaser only if the assignee accepts all obligations in writing; Artist remains liable unless Producer gives a written release. Producer may assign the right to collect and administer Producer’s income, but may not expand Artist’s obligations. The Parties are independent contractors. This Agreement creates no partnership, employment, fiduciary, or agency relationship.

18. NOTICES
Formal notice must be sent by email and by nationally recognized courier or certified mail to the addresses listed above, and is effective on confirmed email delivery plus dispatch of the physical copy. Either Party may update its notice details by the same method.

19. GOVERNING LAW AND VENUE
This Agreement is governed by the laws of the State of ${input.governingState.trim()}, without regard to conflict-of-law rules. The state and federal courts located in ${input.governingCounty.trim()}, ${input.governingState.trim()} have exclusive jurisdiction, and each Party consents to that venue.

20. COMPLETE AGREEMENT; CHANGES; SEVERABILITY; WAIVER
This Agreement is the entire agreement concerning the Beat and replaces prior discussions or messages about it. Any amendment, waiver, additional song, license upgrade, composition-split change, or ownership transfer must be in a writing signed by both Parties. If a provision is unenforceable, it shall be narrowed only as necessary and the remainder remains effective. A delay in enforcing a right is not a waiver. Headings are for convenience and do not change meaning.

21. COUNTERPARTS AND ELECTRONIC SIGNATURES
The Parties intend to be legally bound. Signatures delivered electronically and counterparts signed separately are treated as originals and together form one instrument. Each signer represents that the information entered below is accurate and that the signer received a complete copy of this Agreement.

AGREED AND ACCEPTED:

PRODUCER
Legal name: ${input.producerLegalName.trim()}
Stage/company name: ${input.producerStageName.trim() || 'N/A'}
Signature: ____________________________________
Date: _________________________________________

ARTIST / LICENSEE
Legal name: ${input.artistLegalName.trim()}
Stage/company name: ${input.artistStageName.trim() || 'N/A'}
Signature: ____________________________________
Date: _________________________________________`;
}
