function codeMatches() {
	var match = $('#code').val().match(/[0-9]{3}-?[0-9]{3}/g)
	return match != null && match.length == 1 && match[0] == $('#code').val();
}

function numberMatches() {
	var country_code = $('#countrycode').val().replace(/\D/g, '');
	return $('#number').val().replace(/\D/g, '').length > 5 && country_code.length > 0 && country_code.length < 4;
}

$('#code').on('change', function() {
	if (!codeMatches())
		$('#code').attr('style', 'background-color:#ff6666;');
	else
		$('#code').attr('style', '');
});

$('#number').on('change', function() {//TODO
	if (!numberMatches())
		$('#number').attr('style', 'background-color:#ff6666;');
	else
		$('#number').attr('style', '');
});

var single_device = false;
var signaling_key = getRandomBytes(32 + 20);
var password = btoa(getRandomBytes(16));
password = password.substring(0, password.length - 2);

$('#init-go-single-client').click(function() {
	if (numberMatches()) {
		var number = "+" + $('#countrycode').val().replace(/\D/g, '') + $('#number').val().replace(/\D/g, '');

		$('#init-go').html('Setup');
		$('#countrycode').prop('disabled', 'disabled');
		$('#number').prop('disabled', 'disabled');
		$('#init-go-single-client').prop('disabled', 'disabled');

		single_device = true;

		doAjax({call: 'accounts', httpType: 'GET', urlParameters: '/sms/code/' + number,
			success_callback: function(response) { },
			error_callback: function(code) {
				alert("Failed to send key?" + code); //TODO
			}
		});
	}
});

$('#init-go').click(function() {
	if (codeMatches() && numberMatches()) {
		var number = "+" + $('#countrycode').val().replace(/\D/g, '') + $('#number').val().replace(/\D/g, '');

		$('#init-setup').hide();
		$('#verify1done').html('');
		$('#verify2').hide();
		$('#verify3done').html('');
		$('#verify4done').html('');
		$('#verify').show();

		var call = single_device ? 'accounts' : 'devices';
		var urlPrefix = single_device ? '/code/' : '/';

		doAjax({call: call, httpType:  'PUT', urlParameters: urlPrefix + $('#code').val(), user: number, password: password,
			jsonData: {signalingKey: btoa(getString(signaling_key)), supportsSms: false, fetchesMessages: true},
			success_callback: function(response) {
				if (single_device)
					response = 1;
				var number_id = number + "." + response;
				storage.putEncrypted("password", password);
				storage.putEncrypted('signaling_key', signaling_key);
				storage.putUnencrypted("number_id", number_id);
				$('#verify1done').html('done');

				var register_keys_func = function() {
					$('#verify2done').html('done');
					var keys = crypto.generateKeys();
					$('#verify3done').html('done');
					doAjax({call: 'keys', httpType: 'PUT', do_auth: true, jsonData: keys,
						success_callback: function(response) {
							$('#complete-number').html(number);
							$('#verify').hide();
							$('#setup-complete').show();
							registrationDone();
						}, error_callback: function(code) {
							alert(code); //TODO
						}
					});
				}

				if (!single_device) {
					getKeysForNumber(number, function(identityKey) {
						subscribeToPush(function(message) {
							//TODO receive shared identity key
							register_keys_func();
						});
						requestIdentityPrivKeyFromMasterDevice(number);
					}, function(error_msg) {
						alert(error_msg); //TODO
					});
				} else {
					register_keys_func();
				}
			}, error_callback: function(code) {
				var error;
				switch(code) {
				case 403:
					error = "Invalid code, please try again.";
					break;
				case -1:
					error = "Error connecting to server, please check your network connection.";
					break;
				default:
					error = "Unknown error, please try again later.";
					console.log("Got error code " + code);
				}
				alert(error); //TODO
			}
		});
	}
});

if (!isRegistrationDone()) {
	$('#init-setup').show();
} else {
	$('#complete-number').html(storage.getUnencrypted("number_id").split(".")[0]);
	$('#setup-complete').show();
}
