function cyr_forminator_redirect() {
    ?>
    <script>
    var cyrRedirectFired = false;
    var cyrForms = {
        '10959': 'General Inquiry',
        '11789': 'Buying',
        '11788': 'Selling',
        '10936': 'Luxury',
        '10931': 'Moving Up',
        '10905': 'First Time Buyer',
        '10896': 'Relocation',
        '10891': 'Downsizing',
        '10867': 'Divorce',
        '10820': 'Estate'
    };
    // v3.2: Capture document.referrer once on page load.
    // Only stored if the referrer is from our own site — off-site sources
    // (Google, ChatGPT, social) are intentionally ignored.
    try {
        var ref = document.referrer || '';
        if (ref && ref.indexOf('thecyrteam.com') !== -1) {
            var refUrl = new URL(ref);
            var refPath = refUrl.pathname + (refUrl.search || '');
            sessionStorage.setItem('cyr_referrer_page', refPath);
        }
    } catch (e) {
        // Silent fail — referrer capture is non-essential.
    }
    Object.keys(cyrForms).forEach(function(formId) {
        var selector = '#forminator-module-' + formId;
        jQuery(document).on('click', selector + ' button.forminator-button-submit', function() {
            var name = jQuery(selector + ' input[name="name-1-first-name"]').val() || '';
            var lastName = jQuery(selector + ' input[name="name-1-last-name"]').val() || '';
            var phone = jQuery(selector + ' input[name="phone-1"]').val() || '';
            var email = jQuery(selector + ' input[name="email-1"]').val() || '';
            var scenario = jQuery(selector + ' input[name="hidden-1"]').val() || cyrForms[formId];
            if (name || phone) {
                sessionStorage.setItem('cyr_name', name);
                sessionStorage.setItem('cyr_lastname', lastName);
                sessionStorage.setItem('cyr_phone', phone);
                sessionStorage.setItem('cyr_email', email);
                sessionStorage.setItem('cyr_scenario', scenario);
                sessionStorage.setItem('cyr_form_id', formId);
            }
        });
    });
    jQuery(document).on('forminator:form:submit:success', function(e, data) {
        if (cyrRedirectFired) return;
        var name = sessionStorage.getItem('cyr_name') || '';
        var lastName = sessionStorage.getItem('cyr_lastname') || '';
        var phone = sessionStorage.getItem('cyr_phone') || '';
        var email = sessionStorage.getItem('cyr_email') || '';
        var scenario = sessionStorage.getItem('cyr_scenario') || '';
        var referrer = sessionStorage.getItem('cyr_referrer_page') || '';
        if (!name && !phone) return;
        cyrRedirectFired = true;
        // NEW: hide every form wrapper immediately, before Forminator's own
        // inline "Thank you" success message has a chance to render and
        // flash on screen before the redirect below takes over.
        Object.keys(cyrForms).forEach(function(fid) {
            jQuery('#forminator-module-' + fid).hide();
        });
        sessionStorage.removeItem('cyr_name');
        sessionStorage.removeItem('cyr_lastname');
        sessionStorage.removeItem('cyr_phone');
        sessionStorage.removeItem('cyr_email');
        sessionStorage.removeItem('cyr_scenario');
        sessionStorage.removeItem('cyr_form_id');
        sessionStorage.removeItem('cyr_referrer_page');
        var redirectUrl = 'https://your-situation.netlify.app/?name=' + encodeURIComponent(name)
            + '&lastname=' + encodeURIComponent(lastName)
            + '&phone=' + encodeURIComponent(phone)
            + '&email=' + encodeURIComponent(email)
            + '&scenario=' + encodeURIComponent(scenario);
        if (referrer) {
            redirectUrl += '&referrer=' + encodeURIComponent(referrer);
        }
        window.location.href = redirectUrl;
    });
    </script>
    <?php
}
add_action('wp_footer', 'cyr_forminator_redirect');
