import { describe, expect, it } from 'vitest';
import { buildProducerAgreement, validateProducerAgreement, type ProducerAgreementInput } from './producerAgreement';

const complete = (kind: ProducerAgreementInput['kind']): ProducerAgreementInput => ({
  kind, effectiveDate: '2026-08-24', producerLegalName: 'Alex Producer', producerStageName: 'A. Producer', producerAddress: '100 Studio Ave, New York, NY 10001', producerEmail: 'producer@example.com', artistLegalName: 'Alex Artist', artistStageName: 'Alex', artistAddress: '200 Artist St, Brooklyn, NY 11201', artistEmail: 'artist@example.com', beatTitle: 'Midnight Motion', beatId: 'AP-100', fee: kind === 'exclusive' ? '2500' : '100', currency: 'USD', deliverables: 'Untagged WAV and tracked-out stems', producerCompositionShare: '50', producerMasterRoyalty: kind === 'exclusive' ? '3' : '0', containsSamples: false, sampleDisclosure: '', governingState: 'New York', governingCounty: 'New York County', termYears: '5', copies: '10000', audioStreams: '500000', videoStreams: '250000', musicVideos: '1', radioStations: '10', paidPerformances: true, allowSync: false, priorLicenses: false, priorLicenseNotice: '',
});

describe('producer agreement generator', () => {
  it('rejects a signable document with missing parties and jurisdiction', () => {
    const input = complete('non-exclusive');
    input.artistLegalName = '';
    input.governingState = '';
    expect(validateProducerAgreement(input)).toEqual(expect.arrayContaining(['Artist legal name is required.', 'Governing state is required.']));
  });

  it('builds a substantive non-exclusive agreement with caps and Content ID protection', () => {
    const agreement = buildProducerAgreement(complete('non-exclusive'));
    expect(agreement).toContain('NON-EXCLUSIVE BEAT LICENSE AGREEMENT');
    expect(agreement).toContain('500,000 monetized or non-monetized audio streams');
    expect(agreement).toContain('shall not register the Beat or New Master with YouTube Content ID');
    expect(agreement).toContain('21. COUNTERPARTS AND ELECTRONIC SIGNATURES');
    expect(agreement).toContain('ARTIST / LICENSEE');
  });

  it('builds a prospective exclusive grant and preserves disclosed prior licenses', () => {
    const input = complete('exclusive');
    input.priorLicenses = true;
    input.priorLicenseNotice = 'Jordan Jones, “Northside,” license dated January 8, 2026';
    const agreement = buildProducerAgreement(input);
    expect(agreement).toContain('EXCLUSIVE BEAT LICENSE AGREEMENT');
    expect(agreement).toContain('Producer shall not grant any new license');
    expect(agreement).toContain('Jordan Jones, “Northside,” license dated January 8, 2026');
    expect(agreement).toContain('3% of Gross Master Receipts');
    expect(agreement).toContain('exclusive license, not an assignment');
  });
});
