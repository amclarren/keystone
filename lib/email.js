var _ = require('underscore'),
	keystone = require('../'),
	fs = require('fs'),
	path = require('path'),
	async = require('async'),
	jade = require('jade'),
	moment = require('moment'),
	mandrillapi = require('mandrill-api');

var templateCache = {};


/**
 * Email Class
 * ===========
 * 
 * Helper class for sending emails with Mandrill.
 * 
 * New instances take a `templatePath` string which must be a folder in the
 * emails path, and must contain an `email.jade` which is used as the template
 * for the HTML part of the email.
 * 
 * Once created, emails can be rendered or sent.
 * 
 * Requires the `emails` path option and the `mandrill api key` option to be
 * set on Keystone.
 * 
 * @api public
 */

var Email = function(templatePath) {
	this.templatePath = templatePath;
	return this;
}


/**
 * Renders the email and passes it to the callback. Used by `email.send()` but
 * can also be called directly to generate a preview.
 *
 * @param {Object} locals - object of local variables provided to the jade template
 * @param {Function} callback(err, email)
 * 
 * @api public
 */

Email.prototype.render = function(locals, callback) {
	
	if ('function' == typeof locals && !callback) {
		callback = locals;
		locals = {};
	}
	
	locals = ('object' == typeof locals) ? locals : {};
	callback = ('function' == typeof callback) ? callback : function() {};
	
	var self = this;
	
	_.defaults(locals, {
		pretty: true,
		moment: moment,
		subject: '(no subject)',
		br: function(r) {
			return [
				'border-radius: ' + r + 'px;',
				'-webkit-border-radius: ' + r + 'px;',
				'-moz-border-radius: ' + r + 'px;',
				'-ms-border-radius: ' + r + 'px;',
				'-o-border-radius: ' + r + 'px;'
			].join(' ');
		}
	});
	
	this.compileTemplate(function(err) {
		
		if (err) {
			return callback(err);
		}
		
		var html = templateCache[self.templatePath](locals);
		
		// ensure extended characters are replaced
		html = html.replace(/[\u007f-\uffff]/g, function(c) {
			return '&#x'+('0000'+c.charCodeAt(0).toString(16)).slice(-4)+';';
		});
		
		// process email rules
		var rules = keystone.get('email rules');
		if (rules) {
			
			if (!Array.isArray(rules)) {
				rules = [rules];
			}
			
			_.each(rules, function(rule) {
				if (rule.find && rule.replace) {
					
					var find = rule.find,
						replace = rule.replace;
					
					if ('string' == typeof find) {
						find = new RegExp(find, 'gi');
					}
					
					html = html.replace(find, replace);
				}
			});
			
		}
		
		callback(null, {
			subject: locals.subject,
			html: html
		});
		
	});
	
}


/**
 * Ensures the template for the email has been compiled
 *
 * @param {Function} callback(err)
 * 
 * @api private
 */

Email.prototype.compileTemplate = function(callback) {
	
	if (keystone.get('env') == 'production' && templateCache[this.templatePath])
		return callback();
	
	var self = this,
		fsTemplatePath = path.join(keystone.getPath('emails'), this.templatePath, 'email.jade');
	
	fs.readFile(fsTemplatePath, function(err, contents) {
		
		if (err) {
			return callback(err);
		}
		
		var template = jade.compile(contents, { filename: fs.realpathSync(fsTemplatePath) });
		
		templateCache[self.templatePath] = template;
		
		callback();
		
	});
	
}


/**
 * Prepares the email and sends it
 * 
 * Options:
 * 
 * - mandrill
 *   Initialised Mandrill API instance
 * 
 * - tags
 *   Array of tags to send to Mandrill
 * 
 * - to
 *   Object / String or Array of Objects / Strings to send to, e.g.
 *   ['jed@team9.com.au', { email: 'jed.watson@gmail.com' }]
 *   { email: 'jed@team9.com.au' }
 *   'jed@team9.com.au'
 * 
 * - fromName
 *   Name to send from
 * 
 * - fromEmail
 *   Email address to send from
 *
 * @param {Object} locals (passed to `email.render()`)
 * @param {Object} options
 * @param {Function} callback(err, info)
 * 
 * @api private
 */

Email.prototype.send = function(locals, options, callback) {
	
	this.render(locals, function(err, email) {
		
		callback = ('function' == typeof callback) ? callback : function() {};
		
		if (err) {
			return callback(err);
		}
		
		if ('object' != typeof options) {
			return callback({
				from: 'Email.send',
				key: 'invalid options',
				message: 'options object is required'
			});
		}
		
		if ('string' == typeof options.from) {
			options.fromName = options.from;
			options.fromEmail = options.from;
		} else if ('object' == typeof options.from) {
			options.fromName = options.from.name;
			options.fromEmail = options.from.email;
		}
		
		if (!options.fromName || !options.fromEmail) {
			return callback({
				from: 'Email.send',
				key: 'invalid options',
				message: 'options.fromName and options.fromEmail are required'
			});
		}
		
		if (!options.mandrill) {
			if (!keystone.get('mandrill api key'))
				return callback({
					from: 'Email.send',
					key: 'missing api key',
					message: 'You must either provide a Mandrill API Instance or set the mandrill api key before sending email.'
				});
			options.mandrill = new mandrillapi.Mandrill(keystone.get('mandrill api key'));
		}
		
		options.tags = ('array' == typeof options.tags) ? options.tags : [];
		options.tags.push('sent:' + moment().format('YYYY-MM-DD'));
		
		var recipients = [],
			mergeVars = [];
		
		options.to = Array.isArray(options.to) ? options.to : [options.to];
		
		for (var i = 0; i < options.to.length; i++) {
			
			if ('string' == typeof options.to[i]) {
				options.to[i] = { email: options.to[i] };
			} else if ('object' == typeof options.to[i]) {
				if (!options.to[i].email) {
					return callback({
						from: 'Email.send',
						key: 'invalid recipient',
						message: 'Recipient ' + (i+1) + ' does not have a valid email address.'
					});
				}
			} else {
				return callback({
					from: 'Email.send',
					key: 'invalid recipient',
					message: 'Recipient ' + (i+1) + ' is not a string or an object.'
				});
			}
			
			var recipient = { email: options.to[i].email };
			
			if ('string' == typeof options.to[i].name) {
				recipient.name = options.to[i].name;
			} else if ('object' == typeof options.to[i].name) {
				recipient.name = options.to[i].name.full;
			}
			
			recipients.push(recipient);
			mergeVars.push({ rcpt: recipient.email, vars: [{ name: 'email', content: recipient.email }, { name: 'name', content: recipient.name }] });
		}
		
		var onSuccess = function(info) {
			callback(null, info);
		}
		
		var onFail = function(info) {
			callback({
				from: 'Email.send',
				key: 'send error',
				message: 'Mandrill encountered an error and did not send the emails.',
				info: info
			});
		}
		
		var message = {
			html: email.html,
			subject: email.subject,
			from_name: options.fromName,
			from_email: options.fromEmail,
			tags: options.tags,
			to: recipients,
			merge_vars: mergeVars,
			track_opens: true,
			track_clicks: true,
			preserve_recipients: false,
			inline_css: true,
			async: true
		};
		
		options.mandrill.messages.send({ message: message }, onSuccess, onFail);
		
	});
	
}

exports = module.exports = Email;
